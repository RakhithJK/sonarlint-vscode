/* --------------------------------------------------------------------------------------------
 * SonarLint for VisualStudio Code
 * Copyright (C) 2017-2023 SonarSource SA
 * sonarlint@sonarsource.com
 * Licensed under the LGPLv3 License. See LICENSE.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';
import * as ChildProcess from 'child_process';
import * as FS from 'fs';
import { DateTime } from 'luxon';
import * as Net from 'net';
import * as Path from 'path';
import * as VSCode from 'vscode';
import { LanguageClientOptions, StreamInfo } from 'vscode-languageclient/node';
import { AutoBindingService } from './connected/autobinding';
import { BindingService } from './connected/binding';
import { AllConnectionsTreeDataProvider } from './connected/connections';
import {
  connectToSonarCloud,
  connectToSonarQube,
  editSonarCloudConnection,
  editSonarQubeConnection,
  handleTokenReceivedNotification,
  reportConnectionCheckResult
} from './connected/connectionsetup';
import { hideSecurityHotspot, showHotspotDescription, showSecurityHotspot } from './hotspot/hotspots';
import { AllHotspotsTreeDataProvider, HotspotNode, HotspotTreeViewItem } from './hotspot/hotspotsTreeDataProvider';
import { getJavaConfig, installClasspathListener } from './java/java';
import { LocationTreeItem, navigateToLocation, SecondaryLocationsTree } from './location/locations';
import { SonarLintExtendedLanguageClient } from './lsp/client';
import * as protocol from './lsp/protocol';
import { languageServerCommand } from './lsp/server';
import { showRuleDescription } from './rules/rulepanel';
import { AllRulesTreeDataProvider, RuleNode } from './rules/rules';
import { GitExtension } from './scm/git';
import { initScm } from './scm/scm';
import {
  ConnectionSettingsService,
  getSonarLintConfiguration,
  migrateConnectedModeSettings
} from './settings/connectionsettings';
import { Commands } from './util/commands';
import { installManagedJre, JAVA_HOME_CONFIG, resolveRequirements } from './util/requirements';
import { code2ProtocolConverter, protocol2CodeConverter } from './util/uri';
import * as util from './util/util';

let currentConfig: VSCode.WorkspaceConfiguration;
const FIRST_SECRET_ISSUE_DETECTED_KEY = 'FIRST_SECRET_ISSUE_DETECTED_KEY';
const SONARLINT_CATEGORY = 'sonarlint';
const PATH_TO_COMPILE_COMMANDS = 'pathToCompileCommands';
const FULL_PATH_TO_COMPILE_COMMANDS = `${SONARLINT_CATEGORY}.${PATH_TO_COMPILE_COMMANDS}`;
const DO_NOT_ASK_ABOUT_COMPILE_COMMANDS_FLAG = 'doNotAskAboutCompileCommands';
let remindMeLaterAboutCompileCommandsFlag = false;
const WAIT_FOR_LANGUAGE_SERVER_INITIALIZATION = 5000;
let connectionSettingsService: ConnectionSettingsService;
let bindingService: BindingService;

const DOCUMENT_SELECTOR = [
  { scheme: 'file', pattern: '**/*' },
  {
    notebook: {
      scheme: 'file',
      notebookType: 'jupyter-notebook'
    },
    language: 'python'
  }
];

let sonarlintOutput: VSCode.OutputChannel;
let secondaryLocationsTree: SecondaryLocationsTree;
let issueLocationsView: VSCode.TreeView<LocationTreeItem>;
let languageClient: SonarLintExtendedLanguageClient;
let allConnectionsTreeDataProvider: AllConnectionsTreeDataProvider;
let hotspotsTreeDataProvider: AllHotspotsTreeDataProvider;
let allHotspotsView: VSCode.TreeView<HotspotTreeViewItem>;

export function logToSonarLintOutput(message) {
  if (sonarlintOutput) {
    sonarlintOutput.appendLine(message);
  }
}

function runJavaServer(context: VSCode.ExtensionContext): Promise<StreamInfo> {
  return resolveRequirements(context)
    .catch(error => {
      //show error
      VSCode.window.showErrorMessage(error.message, error.label).then(selection => {
        if (error.label && error.label === selection && error.command) {
          VSCode.commands.executeCommand(error.command, error.commandParam);
        }
      });
      // rethrow to disrupt the chain.
      throw error;
    })
    .then(requirements => {
      return new Promise<StreamInfo>((resolve, reject) => {
        const server = Net.createServer(socket => {
          if (isVerboseEnabled()) {
            logToSonarLintOutput(`Child process connected on port ${(server.address() as Net.AddressInfo).port}`);
            logToSonarLintOutput(`Java resolved to: ${requirements.javaHome}`);
          }
          resolve({
            reader: socket,
            writer: socket
          });
        });
        server.listen(0, () => {
          // Start the child java process
          const port = (server.address() as Net.AddressInfo).port;
          const { command, args } = languageServerCommand(context, requirements, port);
          if (isVerboseEnabled()) {
            logToSonarLintOutput(`Executing ${command} ${args.join(' ')}`);
          }
          const process = ChildProcess.spawn(command, args);

          process.stdout.on('data', function (data) {
            logWithPrefix(data, '[stdout]');
          });
          process.stderr.on('data', function (data) {
            logWithPrefix(data, '[stderr]');
          });
        });
      });
    });
}

function logWithPrefix(data, prefix) {
  if (isVerboseEnabled()) {
    const lines: string[] = data.toString().split(/\r\n|\r|\n/);
    lines.forEach((l: string) => {
      if (l.length > 0) {
        logToSonarLintOutput(`${prefix} ${l}`);
      }
    });
  }
}

function isVerboseEnabled(): boolean {
  return currentConfig.get('output.showVerboseLogs', false);
}

export function toUrl(filePath: string) {
  let pathName = Path.resolve(filePath).replace(/\\/g, '/');

  // Windows drive letter must be prefixed with a slash
  if (pathName[0] !== '/') {
    pathName = '/' + pathName;
  }

  return encodeURI('file://' + pathName);
}

function toggleRule(level: protocol.ConfigLevel) {
  return (ruleKey: string | RuleNode) => {
    const configuration = getSonarLintConfiguration();
    const rules = configuration.get('rules') || {};

    if (typeof ruleKey === 'string') {
      // This is when a rule is deactivated from a code action, and we only have the key, not the default activation.
      // So level should be "off" regardless of the default activation.
      rules[ruleKey] = { level };
    } else {
      // When a rule is toggled from the list of rules, we can be smarter!
      const { key, activeByDefault } = ruleKey.rule;
      if ((level === 'on' && !activeByDefault) || (level === 'off' && activeByDefault)) {
        // Override default
        rules[key] = { level };
      } else {
        // Back to default
        rules[key] = undefined;
      }
    }
    return configuration.update('rules', rules, VSCode.ConfigurationTarget.Global);
  };
}

export function activate(context: VSCode.ExtensionContext) {
  currentConfig = getSonarLintConfiguration();
  util.setExtensionContext(context);
  sonarlintOutput = VSCode.window.createOutputChannel('SonarLint');
  context.subscriptions.push(sonarlintOutput);

  const serverOptions = () => runJavaServer(context);

  const pythonWatcher = VSCode.workspace.createFileSystemWatcher('**/*.py');
  context.subscriptions.push(pythonWatcher);

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    documentSelector: DOCUMENT_SELECTOR,
    synchronize: {
      configurationSection: 'sonarlint',
      fileEvents: pythonWatcher
    },
    uriConverters: {
      code2Protocol: code2ProtocolConverter,
      protocol2Code: protocol2CodeConverter
    },
    diagnosticCollectionName: 'sonarlint',
    initializationOptions: () => {
      return {
        productKey: 'vscode',
        telemetryStorage: Path.resolve(context.extensionPath, '..', 'sonarlint_usage'),
        productName: 'SonarLint VSCode',
        productVersion: util.packageJson.version,
        workspaceName: VSCode.workspace.name,
        firstSecretDetected: isFirstSecretDetected(context),
        showVerboseLogs: VSCode.workspace.getConfiguration().get('sonarlint.output.showVerboseLogs', false),
        platform: getPlatform(),
        architecture: process.arch,
        additionalAttributes: {
          vscode: {
            remoteName: cleanRemoteName(VSCode.env.remoteName),
            uiKind: VSCode.UIKind[VSCode.env.uiKind]
          }
        }
      };
    },
    outputChannel: sonarlintOutput,
    revealOutputChannelOn: 4 // never
  };

  // Create the language client and start the client.
  // id parameter is used to load 'sonarlint.trace.server' configuration
  languageClient = new SonarLintExtendedLanguageClient(
    'sonarlint',
    'SonarLint Language Server',
    serverOptions,
    clientOptions
  );

  ConnectionSettingsService.init(context, languageClient);
  connectionSettingsService = ConnectionSettingsService.instance;
  migrateConnectedModeSettings(currentConfig, connectionSettingsService);

  BindingService.init(languageClient, context.workspaceState, connectionSettingsService);
  bindingService = BindingService.instance;
  AutoBindingService.init(bindingService, context.workspaceState, connectionSettingsService);

  languageClient.start().then(() => {
    installCustomRequestHandlers(context);

    const referenceBranchStatusItem = VSCode.window.createStatusBarItem();
    const scm = initScm(languageClient, referenceBranchStatusItem);
    context.subscriptions.push(scm);
    context.subscriptions.push(
      languageClient.onRequest(protocol.GetBranchNameForFolderRequest.type, folderUri => {
        return scm.getBranchForFolder(VSCode.Uri.parse(folderUri));
      })
    );
    context.subscriptions.push(
      languageClient.onNotification(protocol.SetReferenceBranchNameForFolderNotification.type, params => {
        scm.setReferenceBranchName(VSCode.Uri.parse(params.folderUri), params.branchName);
      })
    );
    context.subscriptions.push(referenceBranchStatusItem);
    VSCode.window.onDidChangeActiveTextEditor(e => scm.updateReferenceBranchStatusItem(e));
  });

  const allRulesTreeDataProvider = new AllRulesTreeDataProvider(() => languageClient.listAllRules());
  const allRulesView = VSCode.window.createTreeView('SonarLint.AllRules', {
    treeDataProvider: allRulesTreeDataProvider
  });
  context.subscriptions.push(allRulesView);

  secondaryLocationsTree = new SecondaryLocationsTree();
  issueLocationsView = VSCode.window.createTreeView('SonarLint.IssueLocations', {
    treeDataProvider: secondaryLocationsTree
  });
  context.subscriptions.push(issueLocationsView);
  context.subscriptions.push(VSCode.commands.registerCommand(Commands.SHOW_ALL_LOCATIONS, showAllLocations));
  context.subscriptions.push(VSCode.commands.registerCommand(Commands.CLEAR_LOCATIONS, clearLocations));
  context.subscriptions.push(VSCode.commands.registerCommand(Commands.NAVIGATE_TO_LOCATION, navigateToLocation));

  context.subscriptions.push(VSCode.commands.registerCommand(Commands.DEACTIVATE_RULE, toggleRule('off')));
  context.subscriptions.push(VSCode.commands.registerCommand(Commands.ACTIVATE_RULE, toggleRule('on')));

  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.SHOW_HOTSPOT_RULE_DESCRIPTION, hotspot =>
      languageClient.showHotspotRuleDescription(hotspot.ruleKey, hotspot.fileUri)
    )
  );

  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.OPEN_HOTSPOT_ON_SERVER, hotspot =>
      languageClient.openHotspotOnServer(hotspot.key, hotspot.fileUri)
    )
  );

  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.SHOW_HOTSPOT_LOCATION, (hotspot: HotspotNode) =>
      languageClient.showHotspotLocations(hotspot.key, hotspot.fileUri)
    )
  );

  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.HIGHLIGHT_REMOTE_HOTSPOT_LOCATION, (hotspot: HotspotNode) =>
      showSecurityHotspot(allHotspotsView, hotspotsTreeDataProvider)
    )
  );

  context.subscriptions.push(VSCode.commands.registerCommand(Commands.CLEAR_HOTSPOT_HIGHLIGHTING, clearLocations));

  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.SHOW_ALL_RULES, () => allRulesTreeDataProvider.filter(null))
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.SHOW_ACTIVE_RULES, () => allRulesTreeDataProvider.filter('on'))
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.SHOW_INACTIVE_RULES, () => allRulesTreeDataProvider.filter('off'))
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.FIND_RULE_BY_KEY, () => {
      VSCode.window
        .showInputBox({
          prompt: 'Rule Key',
          validateInput: value => allRulesTreeDataProvider.checkRuleExists(value)
        })
        .then(key => {
          // Reset rules view filter
          VSCode.commands.executeCommand(Commands.SHOW_ALL_RULES).then(() =>
            allRulesView.reveal(new RuleNode({ key: key.toUpperCase() } as protocol.Rule), {
              focus: true,
              expand: true
            })
          );
        });
    })
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.SHOW_SONARLINT_OUTPUT, () => {
      sonarlintOutput.show();
    })
  );

  context.subscriptions.push(VSCode.commands.registerCommand(Commands.INSTALL_MANAGED_JRE, installManagedJre));

  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.HIDE_HOTSPOT, () => {
      hideSecurityHotspot(hotspotsTreeDataProvider);
      updateSonarLintViewContainerBadge();
    })
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.SHOW_HOTSPOT_DESCRIPTION, showHotspotDescription)
  );

  VSCode.workspace.onDidChangeConfiguration(async event => {
    if (event.affectsConfiguration('sonarlint.rules')) {
      allRulesTreeDataProvider.refresh();
    }
    if (event.affectsConfiguration('sonarlint.connectedMode')) {
      allConnectionsTreeDataProvider.refresh();
    }
  });

  VSCode.workspace.onDidChangeWorkspaceFolders(async _event => {
    AutoBindingService.instance.checkConditionsAndAttemptAutobinding();
  });

  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.CONFIGURE_COMPILATION_DATABASE, configureCompilationDatabase)
  );

  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.CONNECT_TO_SONARQUBE, connectToSonarQube(context))
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.CONNECT_TO_SONARCLOUD, connectToSonarCloud(context))
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.EDIT_SONARQUBE_CONNECTION, editSonarQubeConnection(context))
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.EDIT_SONARCLOUD_CONNECTION, editSonarCloudConnection(context))
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.ADD_PROJECT_BINDING, connection =>
      bindingService.createOrEditBinding(connection.id, connection.contextValue)
    )
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.REMOVE_CONNECTION, async connection => {
      const connectionDeleted = await ConnectionSettingsService.instance.removeConnection(connection);
      if (connectionDeleted) {
        BindingService.instance.deleteBindingsForConnection(connection);
      }
    })
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.EDIT_PROJECT_BINDING, binding =>
      BindingService.instance.createOrEditBinding(
        binding.connectionId,
        binding.contextValue,
        binding.uri,
        binding.serverType
      )
    )
  );
  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.REMOVE_PROJECT_BINDING, binding =>
      BindingService.instance.deleteBindingWithConfirmation(binding)
    )
  );

  context.subscriptions.push(
    VSCode.commands.registerCommand(Commands.AUTO_BIND_WORKSPACE_FOLDERS, () =>
      AutoBindingService.instance.autoBindWorkspace()
    )
  );

  allConnectionsTreeDataProvider = new AllConnectionsTreeDataProvider(languageClient);

  const allConnectionsView = VSCode.window.createTreeView('SonarLint.ConnectedMode', {
    treeDataProvider: allConnectionsTreeDataProvider
  });
  context.subscriptions.push(allConnectionsView);

  hotspotsTreeDataProvider = new AllHotspotsTreeDataProvider(connectionSettingsService);
  allHotspotsView = VSCode.window.createTreeView('SonarLint.SecurityHotspots', {
    treeDataProvider: hotspotsTreeDataProvider
  });

  context.subscriptions.push(allHotspotsView);

  context.subscriptions.push(onConfigurationChange());

  context.subscriptions.push(
    VSCode.extensions.onDidChange(() => {
      installClasspathListener(languageClient);
    })
  );
  installClasspathListener(languageClient);
  setTimeout(() => {
    AutoBindingService.instance.checkConditionsAndAttemptAutobinding();
  }, WAIT_FOR_LANGUAGE_SERVER_INITIALIZATION);
}

function getPlatform(): string {
  const platform = process.platform;
  if (platform === 'linux' && isAlpineLinux()) {
    return 'alpine';
  }
  return platform;
}

// inspired from https://github.com/microsoft/vscode/blob/4e69b30b4c6618e99ffc831bb9441c3e65c6596e/
// src/vs/platform/extensionManagement/common/extensionManagementUtil.ts#L180
function isAlpineLinux(): boolean {
  let fileContent: string | undefined;
  try {
    fileContent = FS.readFileSync('/etc/os-release', 'utf-8');
  } catch (error1) {
    try {
      fileContent = FS.readFileSync('/usr/lib/os-release', 'utf-8');
    } catch (error2) {
      return false;
    }
  }
  return !!fileContent && (fileContent.match(/^ID=([^\u001b\r\n]*)/m) || [])[1] === 'alpine';
}

/**
 * Inspired from https://github.com/microsoft/vscode-extension-telemetry/blob/4408adad49f6da5816c28467d90aec15773773a9/src/common/baseTelemetryReporter.ts#L63
 * Given a remoteName ensures it is in the list of valid ones
 * @param remoteName The remotename
 * @returns The "cleaned" one
 */
function cleanRemoteName(remoteName?: string): string {
  if (!remoteName) {
    return 'none';
  }

  let ret = 'other';
  // Allowed remote authorities
  ['ssh-remote', 'dev-container', 'attached-container', 'wsl', 'codespaces'].forEach((res: string) => {
    if (remoteName.indexOf(`${res}`) === 0) {
      ret = res;
    }
  });

  return ret;
}

async function showNotificationForFirstSecretsIssue(context: VSCode.ExtensionContext) {
  const showProblemsViewActionTitle = 'Show Problems View';
  VSCode.window
    .showWarningMessage(
      'SonarLint detected some secrets in one of the open files.\n' +
        'We strongly advise you to review those secrets and ensure they are not committed into repositories. ' +
        'Please refer to the Problems view for more information.',
      showProblemsViewActionTitle
    )
    .then(action => {
      if (action === showProblemsViewActionTitle) {
        VSCode.commands.executeCommand('workbench.panel.markers.view.focus');
      }
    });
  context.globalState.update(FIRST_SECRET_ISSUE_DETECTED_KEY, true);
}

function isFirstSecretDetected(context: VSCode.ExtensionContext): boolean {
  const result = context.globalState.get(FIRST_SECRET_ISSUE_DETECTED_KEY);
  if (typeof result == 'string') {
    // migrate
    context.globalState.update(FIRST_SECRET_ISSUE_DETECTED_KEY, result === 'true');
  }
  return context.globalState.get(FIRST_SECRET_ISSUE_DETECTED_KEY, false);
}

function installCustomRequestHandlers(context: VSCode.ExtensionContext) {
  languageClient.onNotification(protocol.ShowRuleDescriptionNotification.type, showRuleDescription(context));

  languageClient.onRequest(protocol.GetJavaConfigRequest.type, fileUri => getJavaConfig(languageClient, fileUri));
  languageClient.onRequest(protocol.ScmCheckRequest.type, fileUri => isIgnoredByScm(fileUri));
  languageClient.onRequest(protocol.EditorOpenCheck.type, fileUri => isOpenInEditor(fileUri));
  languageClient.onNotification(protocol.ReportConnectionCheckResult.type, async checkResult => {
    await reportConnectionCheckResult(checkResult);
    allConnectionsTreeDataProvider.reportConnectionCheckResult(checkResult);
  });
  languageClient.onNotification(protocol.ShowNotificationForFirstSecretsIssueNotification.type, () =>
    showNotificationForFirstSecretsIssue(context)
  );
  languageClient.onNotification(protocol.ShowSonarLintOutputNotification.type, () =>
    VSCode.commands.executeCommand(Commands.SHOW_SONARLINT_OUTPUT)
  );
  languageClient.onNotification(protocol.OpenJavaHomeSettingsNotification.type, () =>
    VSCode.commands.executeCommand(Commands.OPEN_SETTINGS, JAVA_HOME_CONFIG)
  );
  languageClient.onNotification(protocol.OpenPathToNodeSettingsNotification.type, () =>
    VSCode.commands.executeCommand(Commands.OPEN_SETTINGS, 'sonarlint.pathToNodeExecutable')
  );
  languageClient.onNotification(protocol.BrowseToNotification.type, browseTo =>
    VSCode.commands.executeCommand(Commands.OPEN_BROWSER, VSCode.Uri.parse(browseTo))
  );
  languageClient.onNotification(protocol.OpenConnectionSettingsNotification.type, isSonarCloud => {
    const targetSection = `sonarlint.connectedMode.connections.${isSonarCloud ? 'sonarcloud' : 'sonarqube'}`;
    return VSCode.commands.executeCommand(Commands.OPEN_SETTINGS, targetSection);
  });
  languageClient.onNotification(protocol.ShowHotspotNotification.type, h =>
    showSecurityHotspot(allHotspotsView, hotspotsTreeDataProvider, h)
  );
  languageClient.onNotification(protocol.ShowIssueOrHotspotNotification.type, showAllLocations);
  languageClient.onNotification(protocol.NeedCompilationDatabaseRequest.type, notifyMissingCompileCommands);
  languageClient.onRequest(protocol.GetTokenForServer.type, serverId => getTokenForServer(serverId));
  languageClient.onNotification(protocol.SubmitTokenNotification.type, token => handleTokenReceivedNotification(token));
  languageClient.onNotification(protocol.PublishHotspotsForFile.type, hotspotsPerFile => {
    hotspotsTreeDataProvider.refresh(hotspotsPerFile);
    updateSonarLintViewContainerBadge();
  });

  async function notifyMissingCompileCommands() {
    if ((await doNotAskAboutCompileCommandsFlag(context)) || remindMeLaterAboutCompileCommandsFlag) {
      return;
    }
    const doNotAskAgainAction = `Don't ask again`;
    const remindMeLaterAction = 'Ask me later';
    const configureCompileCommandsAction = 'Configure compile commands';
    const message = `SonarLint is unable to analyze C and C++ file(s) because there is no configured compilation 
    database.`;
    VSCode.window
      .showWarningMessage(message, configureCompileCommandsAction, remindMeLaterAction, doNotAskAgainAction)
      .then(selection => {
        switch (selection) {
          case doNotAskAgainAction:
            context.workspaceState.update(DO_NOT_ASK_ABOUT_COMPILE_COMMANDS_FLAG, true);
            break;
          case configureCompileCommandsAction:
            configureCompilationDatabase();
            break;
          case remindMeLaterAction:
            remindMeLaterAboutCompileCommandsFlag = true;
            break;
        }
      });
  }
}

function updateSonarLintViewContainerBadge() {
  const allHotspotsCount = hotspotsTreeDataProvider.countAllHotspots();
  allHotspotsView.badge =
    allHotspotsCount > 0
      ? {
          value: allHotspotsCount,
          tooltip: `Total ${allHotspotsCount} Security Hotspots`
        }
      : undefined;
}

async function doNotAskAboutCompileCommandsFlag(context: VSCode.ExtensionContext): Promise<boolean> {
  return context.workspaceState.get(DO_NOT_ASK_ABOUT_COMPILE_COMMANDS_FLAG, false);
}

enum GitReturnCode {
  E_OK = 0,
  E_FAIL = 1,
  E_INVALID = 128
}

function isNeitherOkNorFail(code?: GitReturnCode) {
  return [GitReturnCode.E_OK, GitReturnCode.E_FAIL].indexOf(code) < 0;
}

async function isIgnored(workspaceFolderPath: string, gitCommand: string): Promise<boolean> {
  const { sout, serr } = await new Promise<{ sout: string; serr: string }>((resolve, reject) => {
    ChildProcess.exec(
      gitCommand,
      { cwd: workspaceFolderPath },
      (error: Error & { code?: GitReturnCode }, stdout, stderr) => {
        if (error && isNeitherOkNorFail(error.code)) {
          if (isVerboseEnabled()) {
            logToSonarLintOutput(`Error on git command "${gitCommand}": ${error}`);
          }
          reject(error);
          return;
        }
        resolve({ sout: stdout, serr: stderr });
      }
    );
  });

  if (serr) {
    return Promise.resolve(false);
  }

  return Promise.resolve(sout.length > 0);
}

async function isIgnoredByScm(fileUri: string): Promise<boolean> {
  return performIsIgnoredCheck(fileUri, isIgnored);
}

async function getTokenForServer(serverId: string): Promise<string> {
  return connectionSettingsService.getServerToken(serverId);
}

export async function performIsIgnoredCheck(
  fileUri: string,
  scmCheck: (workspaceFolderPath: string, gitCommand: string) => Promise<boolean>
): Promise<boolean> {
  const parsedFileUri = VSCode.Uri.parse(fileUri);
  const workspaceFolder = VSCode.workspace.getWorkspaceFolder(parsedFileUri);
  if (workspaceFolder == null) {
    logToSonarLintOutput(`The '${fileUri}' file is not in the workspace, consider as not ignored`);
    return Promise.resolve(false);
  }
  const gitExtension = VSCode.extensions.getExtension<GitExtension>('vscode.git').exports;
  if (gitExtension == null) {
    logToSonarLintOutput(`The git extension is not installed, consider the '${fileUri}' file as not ignored`);
    return Promise.resolve(false);
  }
  try {
    const gitApi = gitExtension.getAPI(1);
    const gitPath = gitApi.git.path;
    const repo = gitApi.getRepository(parsedFileUri);
    if (repo) {
      // use the absolute file path, Git is able to manage
      const command = `"${gitPath}" check-ignore "${parsedFileUri.fsPath}"`;
      const fileIgnoredForFolder = await scmCheck(repo.rootUri.fsPath, command);
      return Promise.resolve(fileIgnoredForFolder);
    } else {
      logToSonarLintOutput(`The '${fileUri}' file is not in a git repo, consider as not ignored`);
      return Promise.resolve(false);
    }
  } catch (e) {
    logToSonarLintOutput(`Error requesting ignored status, consider the '${fileUri}' file as not ignored`);
    return Promise.resolve(false);
  }
}

function isOpenInEditor(fileUri: string) {
  const codeFileUri = VSCode.Uri.parse(fileUri).toString(false);
  const textDocumentIsOpen = VSCode.workspace.textDocuments.some(d => d.uri.toString(false) === codeFileUri);
  const notebookDocumentIsOpen = VSCode.workspace.notebookDocuments.some(d => d.uri.toString(false) === codeFileUri);
  return textDocumentIsOpen || notebookDocumentIsOpen;
}

async function showAllLocations(issue: protocol.Issue) {
  await secondaryLocationsTree.showAllLocations(issue);
  if (issue.creationDate) {
    const createdAgo = issue.creationDate
      ? DateTime.fromISO(issue.creationDate).toLocaleString(DateTime.DATETIME_MED)
      : null;
    issueLocationsView.message = createdAgo
      ? `Analyzed ${createdAgo} on '${issue.connectionId}'`
      : `Detected by SonarLint`;
  } else {
    issueLocationsView.message = null;
  }
  if (issue.flows.length > 0) {
    issueLocationsView.reveal(secondaryLocationsTree.getChildren(null)[0]);
  }
}

function clearLocations() {
  secondaryLocationsTree.hideLocations();
  issueLocationsView.message = null;
}

interface IndexQP extends VSCode.QuickPickItem {
  index: number;
}

async function showCompilationDatabaseOptions(paths: VSCode.Uri[]) {
  if (paths.length === 1) {
    return showMessageAndUpdateConfig(paths[0].fsPath);
  }
  const items = paths.map((path, i) => ({ label: path.fsPath, description: ``, index: i }));
  items.sort((i1, i2) => i1.label.localeCompare(i2.label));
  const options = { placeHolder: 'Pick a compilation database' };
  const selection: IndexQP | undefined = await VSCode.window.showQuickPick(items, options);
  if (selection) {
    return showMessageAndUpdateConfig(paths[selection.index].fsPath);
  }
  return undefined;
}

function showMessageAndUpdateConfig(compilationDbPath: string) {
  VSCode.window.showInformationMessage(
    `Analysis configured. Compilation database path is set to: ${compilationDbPath}`
  );
  const [pathForSettings, workspaceFolder] = tryRelativizeToWorkspaceFolder(compilationDbPath);

  if (workspaceFolder !== undefined) {
    const config = VSCode.workspace.getConfiguration(SONARLINT_CATEGORY, workspaceFolder.uri);
    return config.update(PATH_TO_COMPILE_COMMANDS, pathForSettings, VSCode.ConfigurationTarget.WorkspaceFolder);
  }
  return VSCode.workspace
    .getConfiguration()
    .update(FULL_PATH_TO_COMPILE_COMMANDS, pathForSettings, VSCode.ConfigurationTarget.Workspace);
}

function tryRelativizeToWorkspaceFolder(path: string): [string, VSCode.WorkspaceFolder] {
  if (!Path.isAbsolute(path)) {
    return [path, undefined];
  }
  for (const folder of VSCode.workspace.workspaceFolders || []) {
    const folderPath = folder.uri.fsPath;
    if (path.startsWith(folderPath)) {
      const pathWithVariable = `\${workspaceFolder}${path.replace(folderPath, '')}`;
      return [pathWithVariable, folder];
    }
  }
  return [path, undefined];
}

async function configureCompilationDatabase() {
  const paths = (await VSCode.workspace.findFiles(`**/compile_commands.json`)).filter(path =>
    FS.existsSync(path.fsPath)
  );
  if (paths.length === 0) {
    VSCode.window.showWarningMessage(`No compilation databases were found in the workspace\n 
[How to generate compile commands](https://github.com/SonarSource/sonarlint-vscode/wiki/C-and-CPP-Analysis)`);
    VSCode.workspace
      .getConfiguration()
      .update(FULL_PATH_TO_COMPILE_COMMANDS, undefined, VSCode.ConfigurationTarget.Workspace);
  } else {
    await showCompilationDatabaseOptions(paths);
  }
}

function onConfigurationChange() {
  return VSCode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('sonarlint')) {
      return;
    }
    const newConfig = getSonarLintConfiguration();

    const sonarLintLsConfigChanged =
      hasSonarLintLsConfigChanged(currentConfig, newConfig) || hasNodeJsConfigChanged(currentConfig, newConfig);

    if (sonarLintLsConfigChanged) {
      const msg = 'SonarLint Language Server configuration changed, please restart VS Code.';
      const action = 'Restart Now';
      const restartId = 'workbench.action.reloadWindow';
      currentConfig = newConfig;
      VSCode.window.showWarningMessage(msg, action).then(selection => {
        if (action === selection) {
          VSCode.commands.executeCommand(restartId);
        }
      });
    }
    migrateConnectedModeSettings(newConfig, connectionSettingsService);
  });
}

function hasSonarLintLsConfigChanged(oldConfig, newConfig) {
  return !configKeyEquals('ls.javaHome', oldConfig, newConfig) || !configKeyEquals('ls.vmargs', oldConfig, newConfig);
}

function hasNodeJsConfigChanged(oldConfig, newConfig) {
  return !configKeyEquals('pathToNodeExecutable', oldConfig, newConfig);
}

function configKeyEquals(key, oldConfig, newConfig) {
  return oldConfig.get(key) === newConfig.get(key);
}

function configKeyDeepEquals(key, oldConfig, newConfig) {
  // note: lazy implementation; see for something better: https://stackoverflow.com/a/10316616/641955
  // note: may not work well for objects (non-deterministic order of keys)
  return JSON.stringify(oldConfig.get(key)) === JSON.stringify(newConfig.get(key));
}

export function deactivate(): Thenable<void> {
  if (!languageClient) {
    return undefined;
  }
  return languageClient.stop();
}

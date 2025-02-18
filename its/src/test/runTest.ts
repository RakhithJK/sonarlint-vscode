/* --------------------------------------------------------------------------------------------
 * SonarLint for VisualStudio Code
 * Copyright (C) 2017-2023 SonarSource SA
 * sonarlint@sonarsource.com
 * Licensed under the LGPLv3 License. See LICENSE.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as cp from 'child_process';
import * as path from 'path';

import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from 'vscode-test';
import { readdirSync } from 'fs';

const XVFB_DISPLAY = ':10';

async function main() {
  try {
    const xDisplay = process.env['DISPLAY'];
    if (xDisplay) {
      console.log(`Using DISPLAY=${xDisplay}`);
    } else {
      console.warn(`No DISPLAY env variable found, exporting DISPLAY=${XVFB_DISPLAY}`);
      process.env['DISPLAY'] = XVFB_DISPLAY;
    }

    const userDataDir = path.resolve(__dirname, '../../userdir');

    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    const vscodeVersion = process.env['VSCODE_VERSION'];
    const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
    const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

    const vsixes = readdirSync('..').filter(fn => fn.endsWith('.vsix'));
    // Use cp.spawn / cp.exec for custom setup
    cp.spawnSync(cliPath, ['--install-extension', '../' + vsixes[0]], {
      encoding: 'utf-8',
      stdio: 'inherit'
    });

    const testErrors = [];

    const runTestSuite = async (suiteDir: string, workspaceDir?: string) => {
      const launchArgs = [`--user-data-dir=${userDataDir}`];
      if (workspaceDir) {
        launchArgs.unshift(path.resolve(__dirname, `../../samples/${workspaceDir}`));
      }
      try {
        await runTests({
          // Use the specified `code` executable
          vscodeExecutablePath,
          extensionDevelopmentPath,
          extensionTestsPath: path.resolve(__dirname, suiteDir),
          launchArgs
        });
      } catch (testError) {
        testErrors.push(testError);
      }
    };

    // run the integration tests
    await runTestSuite('./suite');
    await runTestSuite('./secretsSuite', 'workspace-secrets.code-workspace');
    await runTestSuite('./pythonSuite', 'workspace-python.code-workspace');
    await runTestSuite('./cfamilySuite', 'workspace-cfamily.code-workspace');

    ['redhat.java', 'vscjava.vscode-maven'].forEach(requiredExtensionId => {
      cp.spawnSync(cliPath, ['--install-extension', requiredExtensionId], {
        encoding: 'utf-8',
        stdio: 'inherit'
      });
    });
    await runTestSuite('./javaSuite', 'workspace-java.code-workspace');

    if (testErrors.length > 0) {
      throw new Error('At least one test suite failed, please check logs above for actual failure.');
    }
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();

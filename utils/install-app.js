/*
 This program and the accompanying materials are
 made available under the terms of the Eclipse Public License v2.0 which accompanies
 this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
 
 SPDX-License-Identifier: EPL-2.0
 
 Copyright Contributors to the Zowe Project.
*/

const fs = require('graceful-fs');
const Promise = require('bluebird');
const path = require('path');
const packagingUtils = require('./packaging-utils');
const serverUtils = require('../lib/util');
const jsonUtils = require('../lib/jsonUtils');
const rmrf = require('rimraf');

//assuming that this is file isnt being called from another that is already using the logger... else expect strange logs
//TO DO - Sean - bootstrap logger
const logger = packagingUtils.coreLogger.makeComponentLogger("install-app"); //should only need one for this program

var messages;
try { // Attempt to get a log message for a language a user may have specified
  messages = require(`../lib/assets/i18n/log/messages_en.json`);
} catch (err) { // If we encountered an error...
  messages = undefined;
}
logger._messages = messages;

const argParser = require('./argumentParser');
//const usage = 'Usage: --inputApp | -i INPUTAPP --pluginsDir | -p PLUGINSDIR '
//      + '--zluxConfig | -c ZLUXCONFIGPATH [--verbose | -v]';

//TODO if plugins get extracted read-only, then how would we go about doing upgrades? read-write for now!
const FILE_WRITE_MODE = 0o660;
const DIR_WRITE_MODE = 0o770;

const OPTION_ARGS = [
  new argParser.CLIArgument('inputApp', 'i', argParser.constants.ARG_TYPE_VALUE),
  new argParser.CLIArgument('pluginsDir', 'p', argParser.constants.ARG_TYPE_VALUE),
  new argParser.CLIArgument('zluxConfig', 'c', argParser.constants.ARG_TYPE_VALUE),
  new argParser.CLIArgument('verbose', 'v', argParser.constants.ARG_TYPE_FLAG)
];

const calledViaCLI = (require.main === module);
let userInput;
let pluginsDir;

if(calledViaCLI){
  const commandArgs = process.argv.slice(2);
  const argumentParser = argParser.createParser(OPTION_ARGS);
  userInput = argumentParser.parse(commandArgs);

  if (!userInput.inputApp || !(!userInput.pluginsDir ^ !userInput.zluxConfig)) {
    logger.severe(`ZWED0006E`); //logger.severe(usage);
    process.exit(1);
  }

  if (userInput.verbose) {
    packagingUtils.coreLogger.setLogLevelForComponentName('install-app', logger.FINE);
  }

  userInput.inputApp = serverUtils.normalizePath(userInput.inputApp);

  if (userInput.pluginsDir) {
    pluginsDir = serverUtils.normalizePath(userInput.pluginsDir); 
  } else {
    userInput.zluxConfig = serverUtils.normalizePath(userInput.zluxConfig);
    const zluxConfig = jsonUtils.parseJSONWithComments(userInput.zluxConfig);
    pluginsDir = serverUtils.normalizePath(
      zluxConfig.pluginsDir,
      process.cwd());
    if (!path.isAbsolute(pluginsDir)){
      //zluxconfig paths relative to whereever that file is
      path.normalize(userInput.zluxConfig,pluginsDir);
    }
  }
  if (isFile(pluginsDir)) {
    packagingUtils.endWithMessage(`App Server plugins directory location given (${pluginsDir}) is not a directory.`);
  }
}

function isFile(path) {
  try {
    let stat = fs.statSync(path);
    return !stat.isDirectory();
  } catch (e) {
    if(calledViaCLI){
      packagingUtils.endWithMessage(`Could not stat destination or temp folder ${path}. Error=${e.message}`);
    } else {
      logger.warn(`ZWED0146W`, path, e.message); //logger.warn(`Could not stat destination or temp folder ${path}. Error=${e.message}`);
      return true;
    }
  }
  return false;
}

function cleanup() {
  logger.warn(`ZWED0147W`); //logger.warn(`Cleanup not yet implemented`);
}

function addToServer(appDir, installDir) {
  try {
    let pluginDefinition = JSON.parse(fs.readFileSync(path.join(appDir,'pluginDefinition.json')));
    logger.info(`ZWED0109I`, pluginDefinition.identifier); //logger.info(`Registering App (ID=${pluginDefinition.identifier}) with App Server`);
    let locatorJSONString =
        `{\n"identifier": "${pluginDefinition.identifier}",\n"pluginLocation": "${appDir.replace(/\\/g,'\\\\')}"\n}`;
    let destination;
    if(calledViaCLI){
      destination = path.join(pluginsDir, pluginDefinition.identifier+'.json');
    } else {
      destination = path.join(installDir, pluginDefinition.identifier+'.json');
    }
    logger.debug('ZWED0286I', destination, locatorJSONString); //logger.debug(`Writing plugin locator file to ${destination}, contents=\n${locatorJSONString}`);
    fs.writeFile(destination, locatorJSONString, {mode: FILE_WRITE_MODE}, (err)=> {
      if(err){
        let errMsg = `App extracted but not registered to App Server due to write fail. Error=${err.message}`;
        if(calledViaCLI){
          packagingUtils.endWithMessage(errMsg);
        } else {
          logger.warn(`ZWED0148W`, err.message); //logger.warn(errMsg);
        return {success: false, message: errMsg};
        }
      }
      logger.info(`ZWED0110I`, pluginDefinition.identifier, appDir); //logger.info(`App ${pluginDefinition.identifier} installed to ${appDir} and registered with App Server`);
      if(calledViaCLI){
        process.exit(0);
      }
    });
    return {success: true, message: pluginDefinition.identifier};
  } catch (e) {
    if(calledViaCLI){
      packagingUtils.endWithMessage(
      `Could not find pluginDefinition.json file in App (dir=${appDir}). Error=${e.message}`);
    }
    logger.warn(`ZWED0149W`, appDir, e.message); //logger.warn(`Could not find pluginDefinition.json file in App (dir=${appDir}). Error=${e.message}`)
    return {success: false, message: `Could not find pluginDefinition.json file in App (dir=${appDir}). Error=${e.message}`};
  }
}

if(calledViaCLI){
  if (!isFile(userInput.inputApp)) {
    const pluginDefinition = packagingUtils.validatePluginInDirectory(userInput.inputApp);
    addToServer(userInput.inputApp);  
  } else {
    packagingUtils.endWithMessage(`App given was not a directory. Not yet implemented: Package extraction`);
  }
}

module.exports.addToServer = addToServer;
module.exports.isFile = isFile;

/*
 This program and the accompanying materials are
 made available under the terms of the Eclipse Public License v2.0 which accompanies
 this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
 
 SPDX-License-Identifier: EPL-2.0
 
 Copyright Contributors to the Zowe Project.
*/

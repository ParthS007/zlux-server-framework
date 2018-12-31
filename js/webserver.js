

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

'use strict';

const Promise = require('bluebird');
const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');
const WebSocket = require('ws');
const expressWs = require('express-ws');
const util = require('./util');
const reader = require('./reader');
const crypto = require('crypto');

const bootstrapLogger = util.loggers.bootstrapLogger;
const contentLogger = util.loggers.contentLogger;
const childLogger = util.loggers.childLogger;

function sanitizeIps(ipAddresses) {
  let set = new Set();
  ipAddresses.forEach((ipAddress)=> {
    if (typeof ipAddress == 'string') {
      set.add(ipAddress);
    } else {
      bootstrapLogger.warn(`Skipping invalid listener address=${ipAddress}`);
    }
  });
  return set;
}

function WebServer() {
  this.config = null;
}
WebServer.prototype = {
  constructor: WebServer,
  config: null,
  httpOptions: null,
  httpsOptions: null,
  httpsServers: [],
  httpServers: [],
  expressWsHttps: [],
  expressWsHttp: [],

  _setErrorLogger(server, type, ipAddress, port) {
    //the server object will not tell the ipAddr & port unless it has successfully connected,
    //making logging poor unless passed
    server.on('error',(e)=> {
      switch (e.code) {
      case 'EADDRINUSE':
        bootstrapLogger.severe(`Could not listen on address ${ipAddress}:${port}. It is already in use by another process.`);
        //While I'd like to close the server here,
        //it seems that an exception is thrown that can't be caught, causing server to stop anyway
        break;
      case 'ENOTFOUND':
      case 'EADDRNOTAVAIL':
        bootstrapLogger.severe(`Could not listen on address ${ipAddress}:${port}. Invalid IP for this system.`);
        //While I'd like to close the server here,
        //it seems that an exception is thrown that can't be caught, causing server to stop anyway
        break;
      default:
        bootstrapLogger.warn(`Unexpected error on server ${ipAddress}:${port}. E=${e}. Stack trace follows.`);
        bootstrapLogger.warn(e.stack);
      }
    });

  },
  
  _loadHttpsKeyData() {
    if (this.config.https.pfx) {
      try {
        this.httpsOptions.pfx = fs.readFileSync(this.config.https.pfx);
        bootstrapLogger.info('Using PFX: '+ this.config.https.pfx);
      } catch (e) {
        bootstrapLogger.warn('Error when reading PFX. Server cannot continue. Error='+e.message);
        //        process.exit(UNP_EXIT_PFX_READ_ERROR);
        throw e;
      }
    } else {
      if (this.config.https.certificates) {
        this.httpsOptions.cert = util.readFilesToArray(
            this.config.https.certificates);
        bootstrapLogger.info('Using Certificate: '
            + this.config.https.certificates);
      }
      if (this.config.https.keys) {
        this.httpsOptions.key = util.readFilesToArray(this.config.https.keys);
      }
    }
    if (this.config.https.certificateAuthorities) {
      this.httpsOptions.ca = util.readFilesToArray(this.config.https.certificateAuthorities);
    }
    if (this.config.https.certificateRevocationLists) {
      this.httpsOptions.crl = util.readFilesToArray(this.config.https.certificateRevocationLists);
    };
  },

  isConfigValid(config) {
    let canRun = false;
    if (config.http && config.http.port) {
      canRun = true;
    } else if (config.https && config.https.port) {
      if (config.https.pfx) {
        canRun = true;
      } else if (config.https.certificates && config.https.keys) {
        canRun = true;
      }
    }
    return canRun;
  },

  setConfig(config) {
    this.config = config;
    if (this.config.http && this.config.http.port) {
      this.httpOptions = {};
    }
    if (this.config.https && this.config.https.port) {
      let options = this.config.https;
      this.httpsOptions = {};
      //secureOptions and secureProtocol documented here: https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options
      if (typeof options.secureOptions == 'number') {
        //the numbers you want here actually come from openssl, and are likely in this file: https://github.com/openssl/openssl/blob/master/include/openssl/ssl.h
        this.httpsOptions.secureOptions = options.secureOptions;
      } else if (typeof options.secureProtocol == 'string') {
        this.httpsOptions.secureProtocol = options.secureProtocol;
      } else {
        let consts = crypto.constants;
        //tls 1.3 was released in 2018, and tls 1.2 should be in this blacklist list when it has widespread support
        this.httpsOptions.secureOptions = consts.SSL_OP_NO_SSLv2 | consts.SSL_OP_NO_SSLv3 | consts.SSL_OP_NO_TLSv1 | consts.SSL_OP_NO_TLSv1_1;
      }
    }
  },

  startListening: Promise.coroutine(function* (app) {
    let t = this;
    if (this.config.https && this.config.https.port) {
      let makeHttpsServer = function*(ipAddress, port) {
        let listening = false;
        let httpsServer;
        t._loadHttpsKeyData();
        while (!listening) {
          try {
            httpsServer = https.createServer(t.httpsOptions, app);
            t._setErrorLogger(httpsServer, 'HTTPS', ipAddress, port);
            t.httpsServers.push(httpsServer);
            t.expressWsHttps.push(expressWs(app, httpsServer, {maxPayload: 50000}));
            listening = true;
          } catch (e) {
            if (e.message == 'mac verify failure') {
              const r = reader();
              try {
                t.httpsOptions.passphrase = yield reader.readPassword(
                  'HTTPS key or PFX decryption failure. Please enter passphrase: ');
              } finally {
                r.close();
              }
            } else {
              throw e;
            }
          }
        }
        t.callListen(httpsServer, 'https', 'HTTPS', ipAddress, port);
      };

     
      if (this.config.https.ipAddresses) {
        let httpsIps = sanitizeIps(this.config.https.ipAddresses);
        let len = httpsIps.size;
        if (len > 0) {
          const iterator = httpsIps.entries();
          for (let ipAddress of iterator) {
            yield* makeHttpsServer(ipAddress[0], this.config.https.port);
          }
        } else {
          yield* makeHttpsServer('0.0.0.0', this.config.https.port);
        }
      } else {
        yield* makeHttpsServer('0.0.0.0', this.config.https.port);
      }
    }
    if (this.config.http && this.config.http.port) {
      let makeHttpServer = function(ipAddress, port) {
        let httpServer = http.createServer(app);
        t._setErrorLogger(httpServer, 'HTTP', ipAddress, port);
        t.httpServers.push(httpServer);
        t.expressWsHttp.push(expressWs(app, httpServer));
        t.callListen(httpServer, 'http', 'HTTP', ipAddress, port);
      }
      
      if (this.config.http.ipAddresses) {
        let httpIps = sanitizeIps(this.config.http.ipAddresses);
        if (httpIps.size > 0) {
          httpIps.forEach((ipAddress)=> {
            makeHttpServer(ipAddress, this.config.http.port);
          });
        } else {
          makeHttpServer('0.0.0.0', this.config.http.port);
        }
      } else {
        makeHttpServer('0.0.0.0', this.config.http.port);
      }
    }
  }),

  callListen(methodServer, methodName, methodNameForLogging, ipAddress, port) {
    const addressForLogging = `${ipAddress}:${port}`;
    const logFunction = function () {
      bootstrapLogger.log(bootstrapLogger.INFO,`(${methodNameForLogging})  Listening on ${addressForLogging}`)
    };
    bootstrapLogger.log(bootstrapLogger.INFO,
                        `(${methodNameForLogging})  About to start listening on ${addressForLogging}`);
    methodServer.listen(port, ipAddress, logFunction);
  },

  close() {
    this.httpServers.forEach((server)=> {
      let info = server.address();
      if (info) {
        //could be undefined if there was an error binding, yet close() still works
        bootstrapLogger.info(`(HTTP) Closing server ${info.address}:${info.port}`);
      }
      server.close();      
    });
    this.httpsServers.forEach((server)=> {
      let info = server.address();
      if (info) {
        //could be undefined if there was an error binding, yet close() still works
        bootstrapLogger.info(`(HTTPS) Closing server ${info.address}:${info.port}`);
      }
      server.close();      
    });
  }
};

module.exports = WebServer;

const _unitTest = false;
function unitTest() {
  const config = {
    "node": {
      "http": {
        "port": 31339,
        "hostname": "127.0.0.1"
      },
      "https": {
        "port": 31340,
        "keys": ["../deploy/product/MVD/serverConfig/server.key"],
        "certificates": ["../deploy/product/MVD/serverConfig/server.cert"]
      }
    }
  };
  const webServer = makeWebServer();
  if (webServer.isConfigValid(config)) {
    bootstrapLogger.info("Config valid");
    webServer.setConfig(config);
    const express = require('express');
    webServer.startListening(express());
  } else {
     bootstrapLogger.warn("Config invalid");
  }
}
if (_unitTest) {
  unitTest();
}
  


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/


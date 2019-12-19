/**
Copyright 2018 Google

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/* jslint node: true */
/* jshint esversion: 8 */
'use strict';

/* Required libraries and supporting vars */
process.env.NODE_CONFIG_DIR = process.env.NODE_CONFIG_DIR || __dirname + '/../config/';
const config = require('config');
const DLP = require('@google-cloud/dlp');
const dlp = new DLP.DlpServiceClient();
const DLP_ALPHABET = "ALPHA_NUMERIC";
const DLP_REGEX = /c(\d+)m(\d+)y(\d+)u(.*)/;
const DLP_SURROGATE_TYPE = 'TOKEN';
const DLP_CUSTOM_INFO_TYPE = [{
  infoType: { name: DLP_SURROGATE_TYPE },
  regex: { pattern:".*" },
  "likelihood" : "VERY_LIKELY"
}];

/* Project variables */
// See config/default.json for more information
const PROJECT_ID = config.get("general.project_id");
const DEBUG_LOGGING = config.get("logging.debug");
const VERSION_LOGGING = config.get("logging.version");

var tmp_dlp_key = {};
if(config.get("dlp.wrapped_key_resource_id") && config.get("dlp.wrapped_key")) {
  tmp_dlp_key = {
    "kmsWrapped": {
      wrappedKey: config.get("dlp.wrapped_key"),
      cryptoKeyName: config.get("dlp.wrapped_key_resource_id")
    }
  };
  debug("Using key wrapped by", tmp_dlp_key.kmsWrapped.cryptoKeyName)
} else {
  tmp_dlp_key = {"unwrapped":{ "key": config.get("dlp.unwrapped_key").toString('utf8') }};
  debug("Using unwrapped key of", Buffer.byteLength(config.get("dlp.unwrapped_key").toString('utf8'), 'utf8'), 'bytes')
}
const DLP_KEY = tmp_dlp_key;

/* Helpful init stuff */
const appVersion = require('fs').statSync(__filename).mtimeMs + " env:" + process.env.NODE_ENV;
// This log line is helpful to keep track of which version of the tokenizer is running.
// The timestamp of index.js is logged at initial script launch as well as each
// individual execution of tokenize() and detokenize()
logVersion(`Tokenizer LAUNCHED v.${appVersion}`);

///////////////////////  DLP DLP DLP ///////////////////////
/**
 * Accepts the following params as an HTTP POST:
 *  project_id - The project ID associated with the auth_token
 *  cc         - 14-16 digit credit card number
 *  mm         - 2 digit month
 *  yyyy       - 4 digit year
 *  user_id     - arbitrary user ID string (optional)
 *
 * Returns an alphanumeric string which can be used as a PCI DSS compliant token
 * in-place of a credit card number in out-of-scope data storage environments.
 *
 * @param {object} req - tokenizer request object
 * @param {object} res - tokenizer response object
 */
exports.dlp_crypto_tokenize = async (req, res) => {
  logVersion(`DLP tokenizing with tokenizer v.${appVersion}`);
  // The value contains a JSON document representing the entity we want to save
  var cc = req.body.cc + "";
  var mm = req.body.mm + "";
  var yyyy = req.body.yyyy + "";
  var userid = req.body.user_id + "";
  var projectId = req.body.project_id || PROJECT_ID || process.env.GCP_PROJECT;

  if (!projectId) {
    return res.status(500).send('Invalid input for project_id');
  }

  if (!cc || cc.length < 14 || cc.length > 16) {
    return res.status(500).send('Invalid input for CC');
  }

  if(!mm || mm < 0 || mm > 12) {
    return res.status(500).send('Invalid input for mm');
  }

  if(!yyyy || yyyy < 2010 || yyyy > 3000) {
    return res.status(500).send('Invalid input for yyyy');
  }

  if(!userid || userid.length < 4) {
    return res.status(500).send('Invalid input for user_id');
  }

  try {
    let request = {
      parent: dlp.projectPath(projectId),
      inspectConfig: {
        // infoTypes: [{name: 'DATE'}, {name: 'CREDIT_CARD_NUMBER'}],
        minLikelihood: 'LIKELIHOOD_UNSPECIFIED',
        includeQuote: false,
        customInfoTypes: DLP_CUSTOM_INFO_TYPE
      },
      deidentifyConfig: {
        infoTypeTransformations: {
          transformations: [
            {
              primitiveTransformation: {
                "cryptoDeterministicConfig":{
                  "cryptoKey": DLP_KEY,
                  surrogateInfoType: {
                    name: DLP_SURROGATE_TYPE,
                  }
                },
              },
            },
          ],
        },
      },
      item: {value:String(`c${cc}m${mm}y${yyyy}u${userid}`)}
    };
    // Run deidentification request
    const [response] = await dlp.deidentifyContent(request);
    const token = response.item.value.replace(/^.*:/,''); // Use regex to deconstruct DLP framing
    if(response.overview.transformationSummaries[0].results[0].code == "ERROR") {
      return res.status(500).send(response);
    } else {
      return res.status(200).send(token);
    }
  }
  catch(err) {
    res.status(500).send(`Error during tokenization: ${err.message}.`);
    return false;
  }
}

/**
 * Accepts the following params as an HTTP POST:
 *  project_id - The project ID associated with the auth_token
 *  token   - The tokenized CC number
 *  user_id     - arbitrary user ID string (optional)
 *
 * If the auth_token was valid, this returns a JSON object containing the
 * sensitive payment card data that was stored under the given token.
 *
 * @param {object} req - tokenizer request object
 * @param {object} res - tokenizer response object
 */
exports.dlp_crypto_detokenize = async (req, res) => {
let i = 0;
  logVersion(`DLP detokenizing ver ${appVersion}`);
  var ccToken = req.body.token + "";
  var userid = req.body.user_id + "";
  var projectId = req.body.project_id || PROJECT_ID || process.env.GCP_PROJECT;

  if (!projectId) {
    return res.status(500).send('Invalid input for project_id');
  }

  if (!ccToken || ccToken.length < 10) {
    throw new Error('Invalid input for token: ' + ccToken);
  }

  if(!userid || userid.length < 4) {
    return res.status(500).send('Invalid input for user_id');
  }

  ccToken = 'TOKEN(' + ccToken.length + '):' + ccToken; // Reconstruct DLP framing

  try {
    const request = {
        parent: dlp.projectPath(projectId),
        inspectConfig: {
          includeQuote: false,
          customInfoTypes: DLP_CUSTOM_INFO_TYPE,
        },
        reidentifyConfig: {
          infoTypeTransformations: {
            transformations: [
              {
                infoTypes: [{ name:DLP_SURROGATE_TYPE }],
                primitiveTransformation: {
                  cryptoDeterministicConfig:{
                    cryptoKey: DLP_KEY,
                    surrogateInfoType: {
                      name: DLP_SURROGATE_TYPE,
                    },
                  },
                },
              },
            ],
          },
        },
        // item: {value: DLP_SURROGATE_TYPE+`(${ccToken.length}):${ccToken}`},
        item: {value: ccToken},
      };

      const [response] = await dlp.reidentifyContent(request);

      if(!response || response === undefined || response.overview.transformationSummaries[0].results[0].code == "ERROR") {
        return res.status(500).send(response);
      }

      let rawDetok = response.item.value.toString();
      let detok = DLP_REGEX.exec(rawDetok);

      if(detok.length != 5) {
        return res.status(500).send("Invalid decoded block size of " + detok.length);
      }

      if(detok[4] !== userid) {
        return res.status(500).send("Could not validate detokenized content");
      }

      let out = {
        cc: detok[1],
        mm: detok[2],
        yyyy: detok[3]
      };

      res.status(200).send(out);
  }
  catch(err) {
    res.status(500).send(`DLP Detokenization error: ${err.message}`);
    return false;
  }
};

/**
 * Helpful debug function that checks for the var DEBUG_LOGGING == true before writing to console.log()
 */
function debug(...args) {
  if(DEBUG_LOGGING) console.log(...args);
}


/**
 * A handy utility function that can write the timestamp of app.js when the tokenizer
 * is first launched and again each time it is executed. This is helpful when trying
 * to link log output of a particular run to the code version that generated it.
 */
function logVersion(...args) {
  if(VERSION_LOGGING) console.log(...args);
}

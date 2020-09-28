/**
 * Copyright 2018, Google, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Compute = require('@google-cloud/compute');
const Buffer  = require('safe-buffer').Buffer;
var isodate   = require("isodate");

const compute = new Compute();


/**
 * Deletes unused Compute Engine instances.
 *
 * Expects a PubSub message with JSON-formatted event data containing the
 * following attributes:
 *  zone (OPTIONAL) - the GCP zone the instances are located in.
 *  label - the label of instances to start.
 *
 * @param {!object} event Cloud Function PubSub message event.
 * @param {!object} callback Cloud Function PubSub callback indicating
 *  completion.
 */
exports.cleanUnusedInstances = (event, context, callback) => {
  try {
    const payload = _validatePayload(
      JSON.parse(Buffer.from(event.data, 'base64').toString()) 
    );
    console.log("-------- Payload----");
    console.log(payload);
    const options = {filter: `labels.${payload.label}`};

    compute.getVMs(options).then(vms => {
      vms[0].forEach(instance => {
        

        // Extracts GCE instance metadata
        var ttl  = instance.metadata.labels.ttl; // TTL in minutes
        var zone = instance.zone.id;

        // Current Datetime 
        const date = new Date()  
        const now = Math.round(date.getTime() / 1000)  // epoch in seconds

        // Calcultes GCE instance creation time
        var creationDate = new Date(instance.metadata.creationTimestamp);
        const creationTime = Math.round(creationDate.getTime() / 1000) // in seconds
        

        var diff = (now - creationTime)/60; // in minutes.
        if (diff>ttl) {
          compute
          .zone(payload.zone)
          .vm(instance.name)
          .delete()
          .then(data => {
            // Operation pending.
            const operation = data[0];
            return operation.promise();
          })
          .then(() => {
            // Operation complete. Instance successfully started.
            const message = 'Successfully deleted instance ' + instance.name;
            console.log(message);
            callback(null, message);
          })
          .catch(err => {
            console.log(err);
            callback(err);
          });
        }
      });
    });
  } catch (err) {
    console.log(err);
    callback(err);
  }
};


/**
 * Validates that a request payload contains the expected fields.
 *
 * @param {!object} payload the request payload to validate.
 * @return {!object} the payload object.
 */
function _validatePayload(payload) {
  /*
    if (!payload.zone) {
      throw new Error(`Attribute 'zone' missing from payload`);
    } else 
  */
  if (!payload.label) {
    throw new Error(`Attribute 'label' missing from payload`);
  }
  return payload;
}


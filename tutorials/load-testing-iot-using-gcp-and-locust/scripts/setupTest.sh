#!/bin/bash

# Sets up everything needed to start a test.
# At the completion of this script, a URL is provided to copy and paste into a browser.
# Environment settings in .env in the repo root directory are used to configure the test.
#
# Usage:
#   ./setupTest.sh

function info {
  echo "LTK: $1"
}

function errorExit {
  info "ERROR: $1"
  exit 1
}

### Make sure we are pointing to the correct GCP project.

info "Setting gcloud command line config to project $LTK_DRIVER_PROJECT_ID"
gcloud config set project $LTK_DRIVER_PROJECT_ID 1>/dev/null 2>&1 || \
  errorExit "Unable to set projectId"

### Make sure kubernetes is clean.

kubectl delete sts locust-worker >/dev/null 2>&1 || true
kubectl delete svc locust-master >/dev/null 2>&1 || true
kubectl delete deployment locust-master >/dev/null 2>&1 || true

### Create the GKE cluster.

# This creates a zonal cluster.
info "Checking GKE for existing ltk-driver cluster"
if [[ `gcloud container clusters list | grep ltk-driver | wc -l` -eq 0 ]]; then
  info "Creating GKE cluster in zone $LTK_DRIVER_ZONE with $LTK_NUM_GKE_NODES nodes"
  info "Ignore WARNINGs and please be patient (may take several minutes)"
  gcloud container clusters create ltk-driver --zone $LTK_DRIVER_ZONE --num-nodes $LTK_NUM_GKE_NODES || \
    errorExit "Unable to create cluster"
else
  info "Skipping creating GKE cluster, already exists."
fi

### From here on we need to be in the LTK root directory (github repo root)

cd $LTK_ROOT

### Build the docker image for the Locust master.

info "Building docker image for Locust master"
docker build -f gke/DockerfileMaster -t gcr.io/$LTK_DRIVER_PROJECT_ID/ltk-master . || \
  errorExit "Unable to build docker image for master"

### Push the docker image to GCR.

info "Pushing docker image for master to GCR"
docker push gcr.io/$LTK_DRIVER_PROJECT_ID/ltk-master:latest || \
  errorExit "Unable to push docker image for master to GCR"

### Set master pod parameters.

# Copy template file into a new yaml file.
echo "# Generated by setupTest.sh, changes will be overwritten when script is run." > gke/locust-master-deployment.yaml
cat gke/locust-master-deployment.template.yaml >> gke/locust-master-deployment.yaml

# ProjectID in GCR image path.
sed -E -i '' "s#image:.*#image: gcr.io/$LTK_DRIVER_PROJECT_ID/ltk-master:latest#" gke/locust-master-deployment.yaml

### Create the kubernetes pod using the image.

info "Creating pod for master"
kubectl create -f gke/locust-master-deployment.yaml || \
  errorExit "Unable to create master pod"

info "Waiting for master pod to enter Running status"
while [ "`kubectl get pods 2>/dev/null | grep "locust-master" | awk '{print $3}'`" != "Running" ]; do sleep 1; done

### Create service for master (load balancer with internet IP for Locust web UI).

info "Creating service for master"
kubectl create -f gke/locust-master-service.yaml || \
  errorExit "Unable to create master service"

info "Waiting for service to obtain external IP (may take several minutes)"
while [[ ! `kubectl get svc | grep master | awk '{print $4}'` =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; do sleep 1; done

masterIP=`kubectl get svc | grep master | awk '{print $4}'`
info "masterIP is $masterIP"

### Generate the DockerfileWorker (so IP change does not change repo file)
echo "# Generated by setupTest.sh, changes will be overwritten when script is run." > gke/DockerfileWorker
cat gke/DockerfileWorker.template >> gke/DockerfileWorker

### Set the master's external IP in DockerfileWorker

sedstr='s#(^CMD.*)"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"#\1"'
sedstr+=$masterIP
sedstr+='"#g'
sed -E -i '' $sedstr gke/DockerfileWorker

### Build the docker image for the Locust worker.

info "Building docker image for Locust worker"
docker build -f gke/DockerfileWorker -t gcr.io/$LTK_DRIVER_PROJECT_ID/ltk-worker . || \
  errorExit "Unable to build docker image for worker"

### Push the worker's docker image to GCR.

info "Pushing docker image for worker to GCR"
docker push gcr.io/$LTK_DRIVER_PROJECT_ID/ltk-worker:latest || \
  errorExit "Unable to push docker image for worker to GCR"

### Set worker pod parameters (number of workers and number of devices per worker registry env vars)

# Copy template file into a new yaml file.
echo "# Generated by setupTest.sh, changes will be overwritten when script is run." > gke/locust-worker-set.yaml
cat gke/locust-worker-set.template.yaml >> gke/locust-worker-set.yaml

# Number of workers (worker pods).
sed -E -i '' "s#replicas: .*#replicas: $LTK_NUM_LOCUST_WORKERS#" gke/locust-worker-set.yaml

# Number of devices per worker is the block size used to shard devicelist.csv in locustfile.py.
numDevices=`cat devicelist.csv | wc -l`
if [[ $(( numDevices % LTK_NUM_LOCUST_WORKERS )) -eq 0 ]]; then
  blockSize=$(( numDevices / LTK_NUM_LOCUST_WORKERS ))
else
  blockSize=$(( numDevices / LTK_NUM_LOCUST_WORKERS + 1 ))
  info "Warning: The number of devices in devicelist.csv is not evenly divisible among the number of workers. All devices will be used, but the last worker will have fewer devices."
fi
info "Number of devices per worker is $blockSize"

# See link for an explanation of this little piece of sed magic:
# https://stackoverflow.com/questions/18620153/find-matching-text-and-replace-next-line
# sed -i '' -e '/BLOCK_SIZE/ {' -e 'n; s/value: ".*"/value: "20"/' -e '}'
# sedstr is the portion inside the curly braces, built like this to get blockSize substitution and quoting right for sed command.
sedstr='n; s/value: ".*"/value: "'
sedstr+=$blockSize
sedstr+='"/'
sed -E -i '' -e '/BLOCK_SIZE/ {' -e "$sedstr" -e '}' gke/locust-worker-set.yaml

# Configure project/region/registry based on settings in .env
sedstr='n; s/value: .*/value: '
sedstr+=$LTK_TARGET_PROJECT_ID
sedstr+='/'
sed -E -i '' -e '/PROJECT_ID/ {' -e "$sedstr" -e '}' gke/locust-worker-set.yaml

sedstr='n; s/value: .*/value: '
sedstr+=$LTK_TARGET_REGION
sedstr+='/'
sed -E -i '' -e '/REGION/ {' -e "$sedstr" -e '}' gke/locust-worker-set.yaml

sedstr='n; s/value: .*/value: '
sedstr+=$LTK_TARGET_REGISTRY_ID
sedstr+='/'
sed -E -i '' -e '/REGISTRY_ID/ {' -e "$sedstr" -e '}' gke/locust-worker-set.yaml

# Set projectId in GCR image path (same line sed is much easier)
sed -E -i '' "s#image: .*#image: gcr.io/$LTK_DRIVER_PROJECT_ID/ltk-worker:latest#" gke/locust-worker-set.yaml

### Create the kubernetes pod for the worker

info "Creating pod for worker"
kubectl create -f gke/locust-worker-set.yaml || \
  errorExit "Unable to create worker pod"

info "Waiting for all $LTK_NUM_LOCUST_WORKERS worker replicas to enter Running status (may take several minutes)"
# expectedReplicas=`grep replicas gke/locust-worker-set.yaml | awk '{print $2}'`
expectedReplicas=$LTK_NUM_LOCUST_WORKERS
currentReplicasCountCmd="kubectl get pods 2>/dev/null | grep locust-worker | grep Running | wc -l"
currentReplicas=$(eval $currentReplicasCountCmd)

while [[ currentReplicas -lt expectedReplicas ]]; do 
  prevReplicas=$currentReplicas
  currentReplicas=$(eval $currentReplicasCountCmd)
  if [[ currentReplicas -gt prevReplicas ]]; then
    info "have $currentReplicas workers"
  fi
  sleep 1
done

### Done

info "Test setup complete, visit http://$masterIP:8089 to launch a test."
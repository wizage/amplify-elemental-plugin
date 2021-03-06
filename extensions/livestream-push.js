const inquirer = require('inquirer');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const chalk = require('chalk');
const sha1 = require('sha1');


module.exports = (context) => {
  context.createLiveStream = async () => {
    await addLivestream(context);
  };
  context.pushStaticFiles = async () => {
    await resetupLivestream(context);
  };
  context.updateLiveStream = async () => {
    await updateLiveStream(context);
  };
  context.removeLiveStream = async () => {
    await removeLiveStream(context);
  };
  context.updateWithProps = async (options, props) => {
    await copyFilesToLocal(context, options, props, 'update');
    await copyFilesToS3(context, options, props);
  };
};

async function removeLiveStream(context) {
  context.amplify.removeResource(context, 'video');
}

async function resetupLivestream(context) {
  const options = {
    service: 'video',
    providerPlugin: 'awscloudformation',
  };

  const props = {};

  const chooseProject = [
    {
      type: 'list',
      name: 'resourceName',
      message: 'Choose what project you want to push the default templates to s3 again?',
      choices: Object.keys(context.amplify.getProjectMeta().video),
      default: Object.keys(context.amplify.getProjectMeta().video)[0],
    },
  ];

  props.shared = await inquirer.prompt(chooseProject);

  await copyFilesToS3(context, options, props);

  console.log(chalk.bold('Your S3 bucket has been setup.'));
}

async function updateLiveStream(context) {
  const options = {
    service: 'video',
    providerPlugin: 'awscloudformation',
  };

  const props = {};
  const chooseProject = [
    {
      type: 'list',
      name: 'resourceName',
      message: 'Choose what project you want to update?',
      choices: Object.keys(context.amplify.getProjectMeta().video),
      default: Object.keys(context.amplify.getProjectMeta().video)[0],
    },
  ];

  props.shared = await inquirer.prompt(chooseProject);

  const result = await serviceQuestions(context, props.shared.resourceName);

  await copyFilesToLocal(context, options, result, 'update');
  await copyFilesToS3(context, options, result);
}

async function addLivestream(context) {
  const options = {
    service: 'video',
    providerPlugin: 'awscloudformation',
  };

  const result = await serviceQuestions(context);
  await copyFilesToLocal(context, options, result, 'add');
  await copyFilesToS3(context, options, result);
}

async function copyFilesToS3(context, options, props) {
  const { amplify } = context;
  const targetDir = amplify.pathManager.getBackendDirPath();
  const targetBucket = amplify.getProjectMeta().providers.awscloudformation.DeploymentBucketName;
  const provider = context.amplify.getPluginInstance(context, options.providerPlugin);

  const aws = await provider.getConfiguredAWSClient(context);
  const s3Client = new aws.S3();
  const distributionDirPath = `${targetDir}/video/${props.shared.resourceName}/src/`;
  const fileuploads = fs.readdirSync(distributionDirPath);

  fileuploads.forEach((filePath) => {
    uploadFile(s3Client, targetBucket, distributionDirPath, filePath);
  });
}

async function uploadFile(s3Client, hostingBucketName, distributionDirPath, filePath) {
  let relativeFilePath = path.relative(distributionDirPath, filePath);

  relativeFilePath = relativeFilePath.replace(/\\/g, '/');

  const fileStream = fs.createReadStream(`${distributionDirPath}/${filePath}`);
  const contentType = mime.lookup(relativeFilePath);
  const uploadParams = {
    Bucket: hostingBucketName,
    Key: `src/${filePath}`,
    Body: fileStream,
    ContentType: contentType || 'text/plain',
    ACL: 'public-read',
  };

  s3Client.upload(uploadParams, (err) => {
    if (err) {
      console.log(chalk.bold('Failed uploading object to S3. Check your connection and try to run amplify livestream setup'));
    }
  });
}

async function copyFilesToLocal(context, options, props, type) {
  const { amplify } = context;
  const targetDir = amplify.pathManager.getBackendDirPath();
  const pluginDir = __dirname;

  const copyJobs = [
    {
      dir: pluginDir,
      template: 'cloudformation-templates/live-workflow.json.ejs',
      target: `${targetDir}/video/${props.shared.resourceName}/${props.shared.resourceName}-live-workflow-template.json`,
    },
  ];

  options.sha = sha1(JSON.stringify(props));

  if (type === 'add') {
    context.amplify.updateamplifyMetaAfterResourceAdd(
      'video',
      props.shared.resourceName,
      options,
    );
  } else if (type === 'update') {
    if (options.sha === context.amplify.getProjectMeta().video[props.shared.resourceName].sha) {
      console.log('Same setting detected. Not updating project.');
      return;
    }
    context.amplify.updateamplifyMetaAfterResourceUpdate(
      'video',
      props.shared.resourceName,
      'sha',
      options.sha,
    );
  }

  await context.amplify.copyBatch(context, copyJobs, props);

  const fileuploads = fs.readdirSync(`${pluginDir}/cloudformation-templates/src/`);

  if (!fs.existsSync(`${targetDir}/video/${props.shared.resourceName}/src/`)) {
    fs.mkdirSync(`${targetDir}/video/${props.shared.resourceName}/src/`);
  }

  fileuploads.forEach((filePath) => {
    fs.copyFileSync(`${pluginDir}/cloudformation-templates/src/${filePath}`, `${targetDir}/video/${props.shared.resourceName}/src/${filePath}`);
  });

  fs.writeFileSync(`${targetDir}/video/${props.shared.resourceName}/props.json`, JSON.stringify(props, null, 4));
}

async function serviceQuestions(context, resourceName) {
  const { amplify } = context;
  const projectMeta = context.amplify.getProjectMeta();
  let resource = {};
  const targetDir = amplify.pathManager.getBackendDirPath();
  let mediaPackageAnswers;
  let cloudFrontAnswers = {};
  const props = {};
  let defaults = {};

  defaults = JSON.parse(fs.readFileSync(`${__dirname}/livestream-defaults.json`));
  defaults.shared.resourceName = amplify.getProjectDetails().projectConfig.projectName;
  try {
    const oldValues = JSON.parse(fs.readFileSync(`${targetDir}/video/${resourceName}/props.json`));
    Object.assign(defaults, oldValues);
  } catch (err) {
    // Do nothing
  }

  const serviceMetadata = JSON.parse(fs.readFileSync(`${__dirname}/livestream-questions.json`)).video;

  const { inputs } = serviceMetadata;

  const nameProject = [
    {
      type: inputs[0].type,
      name: inputs[0].key,
      message: inputs[0].question,
      validate: amplify.inputValidation(inputs[0]),
      default: defaults.shared.resourceName,
    }];

  const defaultQuestions = [
    {
      type: inputs[1].type,
      name: inputs[1].key,
      message: inputs[1].question,
      validate: amplify.inputValidation(inputs[1]),
      default: defaults.shared[inputs[1].key],
    },
    {
      type: inputs[2].type,
      name: inputs[2].key,
      message: inputs[2].question,
      validate: amplify.inputValidation(inputs[2]),
      default: defaults.shared[inputs[2].key],
    },
    {
      type: inputs[3].type,
      name: inputs[3].key,
      message: inputs[3].question,
      validate: amplify.inputValidation(inputs[3]),
      default: defaults.shared[inputs[3].key],
    },
  ];

  const mediaLiveQustions = [
    {
      type: inputs[4].type,
      name: inputs[4].key,
      message: inputs[4].question,
      validate: amplify.inputValidation(inputs[4]),
      default: defaults.mediaLive[inputs[4].key],
    },
    {
      type: inputs[5].type,
      name: inputs[5].key,
      message: inputs[5].question,
      choices: inputs[5].options,
      default: defaults.mediaLive[inputs[5].key],
    },
    {
      type: inputs[6].type,
      name: inputs[6].key,
      message: inputs[6].question,
      choices: inputs[6].options,
      default: defaults.mediaLive[inputs[6].key],
    },
    {
      type: inputs[7].type,
      name: inputs[7].key,
      message: inputs[7].question,
      choices: inputs[7].options,
      default: defaults.mediaLive[inputs[7].key],
    },
  ];

  const mediaPackageQuestions = [
    {
      type: inputs[8].type,
      name: inputs[8].key,
      message: inputs[8].question,
      choices: inputs[8].options,
      default: defaults.mediaPackage[inputs[8].key],
    },
    {
      type: inputs[9].type,
      name: inputs[9].key,
      message: inputs[9].question,
      validate: amplify.inputValidation(inputs[9]),
      default: defaults.mediaPackage[inputs[9].key],
    },
  ];

  const mediaStorage = [
    {
      type: inputs[15].type,
      name: inputs[15].key,
      message: inputs[15].question,
      choices: inputs[15].options,
      default: defaults.mediaStorage[inputs[15].key],
    },
  ];

  const cloudFrontEnable = [
    {
      type: inputs[11].type,
      name: inputs[11].key,
      message: inputs[11].question,
      choices: inputs[11].options,
      default: defaults.cloudFront[inputs[11].key],
    },
  ];

  const cloudFrontQuestions = [
    {
      type: inputs[12].type,
      name: inputs[12].key,
      message: inputs[12].question,
      choices: inputs[12].options,
      default: defaults.cloudFront[inputs[12].key],
    },
    {
      type: inputs[13].type,
      name: inputs[13].key,
      message: inputs[13].question,
      validate: amplify.inputValidation(inputs[13]),
      default: defaults.cloudFront[inputs[13].key],
    },
    {
      type: inputs[14].type,
      name: inputs[14].key,
      message: inputs[14].question,
      validate: amplify.inputValidation(inputs[14]),
      default: defaults.cloudFront[inputs[14].key],
    },
  ];
  if (resourceName) {
    resource.name = resourceName;
  } else {
    resource = await inquirer.prompt(nameProject);
  }

  const answers = await inquirer.prompt(defaultQuestions);
  answers.bucket = projectMeta.providers.awscloudformation.DeploymentBucketName;

  answers.resourceName = resource.name;

  const mediaLiveAnswers = await inquirer.prompt(mediaLiveQustions);
  const mediaStorageAnswers = await inquirer.prompt(mediaStorage);
  if (mediaStorageAnswers.storageType === 'mPackageStore' || mediaStorageAnswers.storageType === 'mPackage') {
    mediaPackageAnswers = await inquirer.prompt(mediaPackageQuestions);
    props.mediaPackage = mediaPackageAnswers;
    const cloudfrontenable = await inquirer.prompt(cloudFrontEnable);
    if (cloudfrontenable.enableDistrubtion === 'YES') {
      cloudFrontAnswers = await inquirer.prompt(cloudFrontQuestions);
    }
    cloudFrontAnswers.enableDistrubtion = cloudfrontenable.enableDistrubtion;
  } else {
    cloudFrontAnswers.enableDistrubtion = 'NO';
  }


  props.shared = answers;
  props.mediaLive = mediaLiveAnswers;
  props.mediaPackage = mediaPackageAnswers;
  props.mediaStorage = mediaStorageAnswers;
  props.cloudFront = cloudFrontAnswers;

  return props;
}

const inquirer = require('inquirer');
const chalk = require('chalk');
const fs = require('fs');
const ini = require('ini');

const debug = false;

module.exports = (context) => {
  context.setupOBS = async () => {
    await getLiveStreamInfo(context);
  };
};

async function getLiveStreamInfo(context) {
  const { amplify } = context;
  let project;
  const amplifyMeta = context.amplify.getProjectMeta();
  if (debug === true) {
    prettifyOutput();
  } else {
    if (!amplifyMeta.video) {
      chalk.bold('You have no video projects.');
    }
    const chooseProject = [
      {
        type: 'list',
        name: 'resourceName',
        message: 'Choose what project you want to configure OBS for?',
        choices: Object.keys(amplifyMeta.video),
        default: Object.keys(amplifyMeta.video)[0],
      },
    ];

    if (!amplify.video && Object.keys(amplifyMeta.video).length !== 0) {
      project = await inquirer.prompt(chooseProject);
      if (amplifyMeta.video[project.resourceName].output) {
        await prettifyOutput(amplifyMeta.video[project.resourceName].output, project.resourceName);
      } else {
        console.log(chalk`{bold You have not pushed ${project.resourceName} to the cloud yet.}`);
      }
    } else {
      console.log(chalk.bold('You have no video projects.'));
    }
  }
}

async function prettifyOutput(output, projectName) {
  // check for obs installation!
  let profileDir = '';
  if (process.platform === 'darwin') {
    profileDir = `${process.env.HOME}/Library/Application Support/obs-studio/basic/profiles/`;
  } else if (process.platform === 'win32') {
    profileDir = `${process.env.APPDATA}/obs-studio/basic/profiles/`;
  } else {
    profileDir = '';
  }

  if (!fs.existsSync(profileDir)) {
    // Ask if they want to continue later
    console.log('OBS profile not folder not found. Switching to project folder.');
    profileDir = `${process.env.PWD}/OBS/`;
    fs.mkdirSync(profileDir);
  }

  profileDir = `${profileDir + projectName}/`;

  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir);
  }

  generateINI(projectName, profileDir);
  generateService(profileDir, output.oMediaLivePrimaryIngestUrl);

  console.log('Configuration complete.');
  console.log(`Open OBS and select ${projectName} profile to use the generated profile for OBS`);
}

async function generateINI(projectName, directory) {
  const iniBasic = ini.parse(fs.readFileSync(`${__dirname}/obs-templates/basic.ini`, 'utf-8'));
  iniBasic.General.Name = projectName;
  fs.writeFileSync(`${directory}basic.ini`, ini.stringify(iniBasic));
}

async function generateService(directory, primaryURL) {
  const primaryKey = primaryURL.split('/');
  const setup = {
    settings: {
      key: primaryKey[3],
      server: primaryURL,
    },
    type: 'rtmp_custom',
  };
  const json = JSON.stringify(setup);
  fs.writeFileSync(`${directory}service.json`, json);
}

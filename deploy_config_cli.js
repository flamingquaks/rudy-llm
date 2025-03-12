#!/usr/bin/env node

import fs from 'fs';
// import path from 'path';
// import readline from 'readline';
import { Command } from 'commander';
import inquirer from 'inquirer';

// Create a new Command instance
const program = new Command();

// Define the configuration schema and CLI
class DeploymentConfig {
  constructor() {
    this.setupCommandLineParser();
  }

  setupCommandLineParser() {
    program
      .name('deploy-config-cli')
      .description('Configuration CLI for deployment settings')
      .option('--acm-cert-arn <arn>', 'ARN of a pre-existing, valid Amazon Certificate Manager certificate')
      .option('--hostname <hostname>', 'Optional hostname to add to CloudFront distribution')
      .option('--storage-type <type>', 'Storage type to use for the deployment', 'efs')
      .option('--enable-sso', 'Enable SSO for the deployment')
      .option('--sso-provider-url <url>', 'SSO provider URL (required if SSO is enabled)')
      .option('--sso-client-id <id>', 'SSO client ID (required if SSO is enabled)')
      .option('-o, --output <filename>', 'Output filename for the configuration', 'deployment_config.json');
  }

  validateAcmCertArn(arn) {
    // Basic pattern for ACM certificate ARN
    const pattern = /^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/[a-zA-Z0-9-]+$/;
    return pattern.test(arn);
  }

  validateSsoConfig(config) {
    if (config.enableSso) {
      if (!config.ssoProviderUrl) {
        console.error('Error: SSO provider URL is required when SSO is enabled');
        return false;
      }
      if (!config.ssoClientId) {
        console.error('Error: SSO client ID is required when SSO is enabled');
        return false;
      }
    }
    return true;
  }

  async runInteractiveMode() {
    console.log('Running in interactive mode...\n');

    const questions = [
      {
        type: 'input',
        name: 'acmCertArn',
        message: 'Enter the ARN of a pre-existing, valid Amazon Certificate Manager certificate:',
        validate: (input) => {
          if (!this.validateAcmCertArn(input)) {
            return 'Please enter a valid ACM certificate ARN';
          }
          return true;
        }
      },
      {
        type: 'input',
        name: 'hostname',
        message: 'Enter hostname to add to CloudFront (optional, press Enter to skip):'
      },
      {
        type: 'list',
        name: 'storageType',
        message: 'Select the storage type:',
        choices: ['efs', 's3'],
        default: 'efs'
      },
      {
        type: 'confirm',
        name: 'enableSso',
        message: 'Do you want to enable SSO?',
        default: false
      }
    ];

    const answers = await inquirer.prompt(questions);

    // If SSO is enabled, ask for additional SSO configuration
    if (answers.enableSso) {
      const ssoQuestions = [
        {
          type: 'input',
          name: 'ssoProviderUrl',
          message: 'Enter the SSO provider URL:',
          validate: (input) => input ? true : 'SSO provider URL is required'
        },
        {
          type: 'input',
          name: 'ssoClientId',
          message: 'Enter the SSO client ID:',
          validate: (input) => input ? true : 'SSO client ID is required'
        }
      ];

      const ssoAnswers = await inquirer.prompt(ssoQuestions);
      Object.assign(answers, ssoAnswers);
    }

    // Ask for output filename
    const outputQuestion = {
      type: 'input',
      name: 'outputFilename',
      message: 'Enter output filename for the configuration:',
      default: 'deployment_config.json'
    };

    const { outputFilename } = await inquirer.prompt(outputQuestion);
    
    return { ...answers, outputFilename };
  }

  buildConfig(options) {
    const config = {
      acm_cert_arn: options.acmCertArn,
      storage_type: options.storageType
    };

    if (options.hostname) {
      config.hostname = options.hostname;
    }

    if (options.enableSso) {
      config.sso = {
        provider_url: options.ssoProviderUrl,
        client_id: options.ssoClientId
      };
    }

    return config;
  }

  saveConfig(config, outputFile) {
    try {
      fs.writeFileSync(outputFile, JSON.stringify(config, null, 2));
      console.log(`Configuration saved to ${outputFile}`);
    } catch (error) {
      console.error(`Error saving configuration: ${error.message}`);
      process.exit(1);
    }
  }

  async run() {
    program.parse();
    const options = program.opts();
    
    let config;
    let outputFilename;

    // Check if any arguments were provided
    const hasArgs = Object.keys(options).length > 0;

    if (hasArgs && options.acmCertArn) {
      // Command line mode
      // Convert commander options to our config format
      const configOptions = {
        acmCertArn: options.acmCertArn,
        hostname: options.hostname,
        storageType: options.storageType || 'efs',
        enableSso: options.enableSso || false,
        ssoProviderUrl: options.ssoProviderUrl,
        ssoClientId: options.ssoClientId
      };

      // Validate inputs
      if (!this.validateAcmCertArn(configOptions.acmCertArn)) {
        console.error(`Error: Invalid ACM certificate ARN format: ${configOptions.acmCertArn}`);
        process.exit(1);
      }

      if (!this.validateSsoConfig(configOptions)) {
        process.exit(1);
      }

      config = this.buildConfig(configOptions);
      outputFilename = options.output || 'deployment_config.json';
    } else {
      // Interactive mode
      const interactiveOptions = await this.runInteractiveMode();
      config = this.buildConfig(interactiveOptions);
      outputFilename = interactiveOptions.outputFilename;
    }

    // Display the final configuration
    console.log('\nDeployment Configuration:');
    console.log(JSON.stringify(config, null, 2));

    // Save the configuration
    this.saveConfig(config, outputFilename);
  }
}

// Create and run the CLI
const cli = new DeploymentConfig();
cli.run().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
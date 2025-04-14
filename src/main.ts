import { App, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { OpenWebUIEcsConstruct } from './llm-construct';
import { loadConfig, DeploymentConfig } from './config';

export interface OpenWebUIStackProps extends StackProps {
  config: DeploymentConfig;
}

export class OpenWebUIStack extends Stack {
  constructor(scope: Construct, id: string, props: OpenWebUIStackProps) {
    super(scope, id, props);

    new OpenWebUIEcsConstruct(this, 'OpenWebUIEcsConstruct', {
      acmCertArn: props.config.acm_cert_arn,
      storageType: props.config.storage_type,
      hostname: props.config.hostname,
      ssoConfig: props.config.sso,
    });
  }
}

// Load configuration
let config: DeploymentConfig;
try {
  // Get config path from command line arguments if provided
  const configArg = process.argv.find(arg => arg.startsWith('--config='));
  const configPath = configArg ? configArg.split('=')[1] : undefined;
  
  config = loadConfig(configPath);
  console.log('Configuration loaded successfully');
} catch (error) {
  console.error('Error loading configuration:', error instanceof Error ? error.message : error);
  process.exit(1);
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new OpenWebUIStack(app, 'OpenWebUIStack', { 
  env: devEnv,
  config: config
});

app.synth();
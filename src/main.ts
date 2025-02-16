import { App, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { OpenWebUIEcsStack } from './llm-construct';

export class RudyLLMStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    new OpenWebUIEcsStack(this, 'OpenWebUIEcsStack');
  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new RudyLLMStack(app, 'rudy-llm', { env: devEnv });

app.synth();
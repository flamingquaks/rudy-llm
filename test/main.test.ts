// We recommend installing an extension to run jest tests.
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RudyLLMStack } from '../src/main';

describe('RudyLLMStack', () => {
  let app: App;
  let stack: RudyLLMStack;
  let template: Template;

  beforeAll(() => {
    app = new App();
    stack = new RudyLLMStack(app, 'TestRudyLLMStack');
    template = Template.fromStack(stack);
  });
  // filepath: /Users/addierudy/projects/rudy-llm/test/main.test.ts

  test('Snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });

  test('Stack has correct name', () => {
    expect(stack.stackName).toEqual('TestRudyLLMStack');
  });
});
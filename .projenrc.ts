import { awscdk } from "projen";
import { NodePackageManager } from "projen/lib/javascript";
const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: "2.178.2",
  defaultReleaseBranch: "main",
  name: "rudy-llm",
  projenrcTs: true,
  eslint: false,
  jest: false,
  packageManager: NodePackageManager.NPM,
  gitignore: [
    '.aider*'
  ],
  deps: [
    "uuid",
  ],
  devDeps: [
    "eslint",
    "globals",
    "@eslint/js",
    "typescript-eslint",
    "jest",
    "ts-jest",
    "@types/jest",
    'commander',
    'inquirer',
  ]
});
project.addTask("lint", {
  exec: "eslint",
  description: "Run eslint"
});
project.addTask("jest", {
  exec: "jest -u",
  description: "Run jest tests"
})

project.addTask('config', {
  exec: 'node deploy_config_cli.js',
  description: 'Runs the config CLI to setup the project for deployment. (Optional, project will deploy with defaults)'
})



project.synth();
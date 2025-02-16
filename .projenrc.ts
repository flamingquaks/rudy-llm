import { awscdk } from "projen";
import { NodePackageManager } from "projen/lib/javascript";
const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: "2.1.0",
  defaultReleaseBranch: "main",
  name: "rudy-llm",
  projenrcTs: true,
  eslint: false,
  jest: false,
  packageManager: NodePackageManager.NPM,
  deps: [
  ],
  devDeps: [
    "eslint",
    "globals",
    "@eslint/js",
    "typescript-eslint",
    "jest",
    "ts-jest",
    "@types/jest",
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


project.synth();
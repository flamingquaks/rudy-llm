# OpenWebUI Deployment with Configuration CLI

This project provides a CDK application for deploying OpenWebUI with configurable options using a command-line interface.

## Configuration CLI

The project includes a configuration CLI tool that allows you to set up your deployment parameters:

```bash
# Install dependencies
npm install

# Run the CLI in interactive mode
node deploy_config_cli.js

# Or provide arguments directly
node deploy_config_cli.js --acm-cert-arn arn:aws:acm:us-east-1:123456789012:certificate/abcd1234 --hostname example.com --storage-type s3 --enable-sso --sso-provider-url https://sso.example.com --sso-client-id client123
```

### Configuration Options

- `acm-cert-arn` (required): ARN of a pre-existing, valid Amazon Certificate Manager certificate
- `hostname` (optional): Custom hostname to add to CloudFront distribution
- `storage-type` (optional): Storage type to use (efs or s3, default: efs)
- `enable-sso` (optional): Enable SSO for the deployment
- `sso-provider-url` (required if SSO is enabled): SSO provider URL
- `sso-client-id` (required if SSO is enabled): SSO client ID

## Deploying with CDK

After generating your configuration, deploy using CDK:

```bash
# Deploy with default configuration file (deployment_config.json)
npx cdk deploy

# Deploy with a specific configuration file
npx cdk deploy --context config=my-config.json
```

## Features

- CloudFront distribution with optional custom domain
- Choice of storage backend (EFS or S3)
- Optional SSO integration
- Fargate-based deployment with auto-scaling

## Requirements

- AWS CDK v2
- Node.js 18+
- Valid ACM certificate
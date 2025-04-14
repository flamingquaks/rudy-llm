import * as fs from 'fs';
import * as path from 'path';

export interface DeploymentConfig {
  acm_cert_arn: string;
  storage_type: 'efs' | 's3';
  hostname?: string;
  sso?: {
    provider_url: string;
    client_id: string;
  };
}

export function loadConfig(configPath?: string): DeploymentConfig {
  // Default config path
  const defaultConfigPath = path.resolve(process.cwd(), 'deployment_config.json');
  
  // Use provided config path or default
  const configFilePath = configPath || defaultConfigPath;
  
  try {
    if (!fs.existsSync(configFilePath)) {
      throw new Error(`Configuration file not found at: ${configFilePath}`);
    }
    
    const configData = fs.readFileSync(configFilePath, 'utf8');
    const config = JSON.parse(configData) as DeploymentConfig;
    
    // Validate required fields
    if (!config.acm_cert_arn) {
      throw new Error('Missing required field: acm_cert_arn');
    }
    
    if (!config.storage_type) {
      // Set default storage type if not specified
      config.storage_type = 'efs';
    } else if (config.storage_type !== 'efs' && config.storage_type !== 's3') {
      throw new Error('Invalid storage_type: must be either "efs" or "s3"');
    }
    
    // Validate SSO config if present
    if (config.sso) {
      if (!config.sso.provider_url) {
        throw new Error('Missing required field: sso.provider_url');
      }
      if (!config.sso.client_id) {
        throw new Error('Missing required field: sso.client_id');
      }
    }
    
    return config;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load configuration: ${error.message}`);
    }
    throw new Error('Failed to load configuration: Unknown error');
  }
}
import { RemovalPolicy, CfnOutput, Stack } from 'aws-cdk-lib';
import { PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { Vpc, Peer, Port, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Cluster, FargateTaskDefinition, ContainerImage, LogDrivers, Secret as ECSSecret, FargateService } from 'aws-cdk-lib/aws-ecs';
import { FileSystem, PerformanceMode } from 'aws-cdk-lib/aws-efs';
import { AllowedMethods, CachePolicy, Distribution, OriginProtocolPolicy, OriginRequestPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { LoadBalancerV2Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AwsCustomResource, AwsCustomResourcePolicy } from 'aws-cdk-lib/custom-resources';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
// import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';

export class OpenWebUIEcsConstruct extends Construct {
    constructor(scope: Construct, id: string) {
        super(scope, id);

        // At the top of your constructor, get the account and region. You might get them via Stack props or from environment variables.
        const accountId = Stack.of(this).account;
        const region = Stack.of(this).region;
        const acmContextKey = `acm-arn:account=${accountId}:region=${region}`;
        const acmArn = this.node.tryGetContext(acmContextKey);

        

        // API Key Secret
        const apiKeySecret = new Secret(this, 'APIKeySecret', {
            generateSecretString: {
                secretStringTemplate: JSON.stringify({
                    "apiKey": "REPLACE_ME"
                }),
                generateStringKey: 'apiKey',
                excludePunctuation: true,
                includeSpace: false,
            },
        });

        // VPC and Cluster
        const vpc = new Vpc(this, 'OpenWebUIVpc', { maxAzs: 2 });
        const cluster = new Cluster(this, 'OpenWebUICluster', { vpc });

        // EFS Setup
        const fileSystem = new FileSystem(this, 'EfsFileSystem', {
            vpc,
            removalPolicy: RemovalPolicy.DESTROY,
            performanceMode: PerformanceMode.GENERAL_PURPOSE,
        });

        fileSystem.connections.allowDefaultPortFrom(Peer.ipv4(vpc.vpcCidrBlock));

        const openWebUIAccessPoint = fileSystem.addAccessPoint('OpenWebUIAccessPoint', {
            path: '/openwebui',
            createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
            posixUser: { uid: '1000', gid: '1000' },
        });

        const pipelinesAccessPoint = fileSystem.addAccessPoint('PipelinesAccessPoint', {
            path: '/pipelines',
            createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
            posixUser: { uid: '1000', gid: '1000' },
        });

        // -----------------------------
        // OAuth2 Proxy Authentication Secret
        // -----------------------------
        const oidcSecret = new Secret(this, 'OIDCSecret', {
            description: 'OIDC authentication credentials for OpenWebUI',
            generateSecretString: {
                secretStringTemplate: JSON.stringify({
                    "OAUTH2_PROXY_CLIENT_ID": "placeholder-client-id",
                    "OAUTH2_PROXY_CLIENT_SECRET": "placeholder-client-secret",
                    "OAUTH2_PROXY_COOKIE_SECRET": "placeholder-cookie-secret",
                    "OAUTH2_PROXY_OIDC_ISSUER_URL": "https://placeholder-provider-url",
                    "OAUTH2_PROXY_EMAIL_DOMAINS": "*"
                }),
                generateStringKey: 'dummy' // This is required but won't be used
            }
        });

        // -----------------------------
        // ECS Task Definition and Containers
        // -----------------------------
        const taskDefinition = new FargateTaskDefinition(this, 'OpenWebUITaskDef', {
            cpu: 4096,
            memoryLimitMiB: 8192,
        });

        taskDefinition.addToTaskRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['bedrock:*'],
            resources: ['*'],
        }));
        
        // Add permission to read the OAuth2 secret
        taskDefinition.addToTaskRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret'
            ],
            resources: [oidcSecret.secretArn],
        }));

        taskDefinition.addVolume({
            name: 'openwebuiVolume',
            efsVolumeConfiguration: {
                fileSystemId: fileSystem.fileSystemId,
                transitEncryption: 'ENABLED',
                authorizationConfig: { accessPointId: openWebUIAccessPoint.accessPointId, iam: 'DISABLED' },
            },
        });

        taskDefinition.addVolume({
            name: 'pipelinesVolume',
            efsVolumeConfiguration: {
                fileSystemId: fileSystem.fileSystemId,
                transitEncryption: 'ENABLED',
                authorizationConfig: { accessPointId: pipelinesAccessPoint.accessPointId, iam: 'DISABLED' },
            },
        });

        // OpenWebUI Container
        const openWebUIContainer = taskDefinition.addContainer('openwebui', {
            image: ContainerImage.fromRegistry('ghcr.io/open-webui/open-webui:main'),
            logging: LogDrivers.awsLogs({ streamPrefix: 'openwebui' }),
            environment: {
                DATA_DIR: '/app/backend/data',
                PIPELINES_URL: 'http://pipelines:9099',
                AUTH_TYPE: 'oauth2-proxy',
                AUTH_HOST: 'http://localhost:4180',
            }
        });
        openWebUIContainer.addPortMappings({ containerPort: 8080 });
        openWebUIContainer.addMountPoints({
            containerPath: '/app/backend/data',
            sourceVolume: 'openwebuiVolume',
            readOnly: false,
        });

        const pipelinesContainer = taskDefinition.addContainer('pipelines', {
            image: ContainerImage.fromRegistry('ghcr.io/open-webui/pipelines:main'),
            logging: LogDrivers.awsLogs({ streamPrefix: 'pipelines' }),
            secrets: {
                PIPELINES_API_KEY: ECSSecret.fromSecretsManager(apiKeySecret, 'apiKey'),
            },
            essential: true
        });
        pipelinesContainer.addPortMappings({ containerPort: 9099 });
        pipelinesContainer.addMountPoints({
            containerPath: '/app/pipelines',
            sourceVolume: 'pipelinesVolume',
            readOnly: false,
        });

        // CloudFront Prefix List Lookup
        const cfPrefixListResource = new AwsCustomResource(this, 'CfPrefixListLookup', {
            onUpdate: {
                service: 'EC2',
                action: 'describeManagedPrefixLists',
                parameters: {
                    Filters: [
                        {
                            Name: 'prefix-list-name',
                            Values: ['com.amazonaws.global.cloudfront.origin-facing'],
                        },
                    ],
                },
                physicalResourceId: PhysicalResourceId.of('CfPrefixListLookup'),
            },
            installLatestAwsSdk: false,
            policy: AwsCustomResourcePolicy.fromSdkCalls({
                resources: AwsCustomResourcePolicy.ANY_RESOURCE,
            }),
        });
        const cfPrefixListId = cfPrefixListResource.getResponseField('PrefixLists.0.PrefixListId');

        // Security Groups
        const serviceSG = new SecurityGroup(this, 'ServiceSG', { vpc });
        const openWebUIAlbSG = new SecurityGroup(this, 'OpenWebUIAlbSG', { vpc });
        // Allow ALB to access service
        serviceSG.connections.allowFrom(openWebUIAlbSG, Port.tcp(8080));        
        // Allow CloudFront to access ALBs
        openWebUIAlbSG.addIngressRule(Peer.prefixList(cfPrefixListId), Port.tcp(80));


        // Fargate Service
        const fargateService = new FargateService(this, 'OpenWebUIService', {
            cluster,
            taskDefinition,
            securityGroups: [serviceSG],
            vpcSubnets: { subnetType: SubnetType.PUBLIC },
            assignPublicIp: true,
            desiredCount: 1,
            minHealthyPercent: 50,
        });
        
        if (acmArn) {
            const pipelinesAlbSG = new SecurityGroup(this, 'PipelinesAlbSG', { vpc });
            pipelinesAlbSG.addIngressRule(Peer.anyIpv4(), Port.tcp(443));
            const pipelinesAlb = new ApplicationLoadBalancer(this, 'PipelinesAlb', {
                vpc,
                internetFacing: true,
                securityGroup: pipelinesAlbSG,
            });
            const pipelinesTargetGroup = new ApplicationTargetGroup(this, 'PipelinesTargetGroup', {
                vpc,
                port: 9099,
                protocol: ApplicationProtocol.HTTP,
                targetType: TargetType.IP,
                healthCheck: {
                    path: '/',
                    healthyHttpCodes: '200',
                },
            });
            pipelinesTargetGroup.addTarget(fargateService.loadBalancerTarget({
                containerName: 'pipelines',
                containerPort: 9099
            }));
            pipelinesAlb.addListener('PipelinesListener', {
                port: 443,
                protocol: ApplicationProtocol.HTTPS,
                certificates: [{
                    certificateArn: acmArn,
                }],
                defaultTargetGroups: [pipelinesTargetGroup],
            });
        }
        
        

        

        // Load Balancers
        const openWebUIAlb = new ApplicationLoadBalancer(this, 'OpenWebUIAlb', {
            vpc,
            internetFacing: true,
            securityGroup: openWebUIAlbSG,
        });

       

        // Target Groups
        const openWebUITargetGroup = new ApplicationTargetGroup(this, 'OpenWebUITargetGroup', {
            vpc,
            port: 8080,
            protocol: ApplicationProtocol.HTTP,
            targetType: TargetType.IP,
            healthCheck: {
                path: '/',
                healthyHttpCodes: '200',
            },
        });
        openWebUITargetGroup.addTarget(fargateService.loadBalancerTarget({
            containerName: 'openwebui',
            containerPort: 8080
        }));

        


        // ALB Listeners
        openWebUIAlb.addListener('OpenWebUIListener', {
            port: 80,
            protocol: ApplicationProtocol.HTTP,
            defaultTargetGroups: [openWebUITargetGroup],
        });

       

        // CloudFront Distributions
        const openwebuiDistribution = new Distribution(this, 'WebUIDistribution', {
            defaultBehavior: {
                allowedMethods: AllowedMethods.ALLOW_ALL,
                origin: new LoadBalancerV2Origin(openWebUIAlb, {
                    protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
                }),
                originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
                cachePolicy: CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS,
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
        });


        // Outputs
        new CfnOutput(this, 'OpenWebUI-CloudFrontDomain', {
            value: openwebuiDistribution.domainName,
            description: 'The CloudFront distribution domain name for Open WebUI.',
        });

        // OAuth2 Proxy Container (after CloudFront distribution is created to use its domain)
        const oauth2ProxyContainer = taskDefinition.addContainer('oauth2-proxy', {
            image: ContainerImage.fromRegistry('quay.io/oauth2-proxy/oauth2-proxy:latest'),
            logging: LogDrivers.awsLogs({ streamPrefix: 'oauth2-proxy' }),
            environment: {
                OAUTH2_PROXY_HTTP_ADDRESS: '0.0.0.0:4180',
                OAUTH2_PROXY_PROVIDER: 'oidc',
                OAUTH2_PROXY_UPSTREAMS: 'http://127.0.0.1:8080',
                OAUTH2_PROXY_COOKIE_SECURE: 'true',
                OAUTH2_PROXY_SKIP_PROVIDER_BUTTON: 'true',
                OAUTH2_PROXY_PASS_ACCESS_TOKEN: 'true',
                OAUTH2_PROXY_PASS_USER_HEADERS: 'true',
                OAUTH2_PROXY_SET_XAUTHREQUEST: 'true',
                // Force HTTPS for redirect URI using CloudFront domain
                OAUTH2_PROXY_REDIRECT_URL: `https://${openwebuiDistribution.domainName}/oauth2/callback`,
                OAUTH2_PROXY_FORCE_HTTPS: 'true',
            },
            secrets: {
                OAUTH2_PROXY_CLIENT_ID: ECSSecret.fromSecretsManager(oidcSecret, 'OAUTH2_PROXY_CLIENT_ID'),
                OAUTH2_PROXY_CLIENT_SECRET: ECSSecret.fromSecretsManager(oidcSecret, 'OAUTH2_PROXY_CLIENT_SECRET'),
                OAUTH2_PROXY_COOKIE_SECRET: ECSSecret.fromSecretsManager(oidcSecret, 'OAUTH2_PROXY_COOKIE_SECRET'),
                OAUTH2_PROXY_OIDC_ISSUER_URL: ECSSecret.fromSecretsManager(oidcSecret, 'OAUTH2_PROXY_OIDC_ISSUER_URL'),
                OAUTH2_PROXY_EMAIL_DOMAINS: ECSSecret.fromSecretsManager(oidcSecret, 'OAUTH2_PROXY_EMAIL_DOMAINS'),
            }
        });
        oauth2ProxyContainer.addPortMappings({ containerPort: 4180 });

        new CfnOutput(this, 'OAuth2SecretArn', {
            value: oidcSecret.secretArn,
            description: 'ARN of the OAuth2 Proxy credentials secret',
        });

    }
}

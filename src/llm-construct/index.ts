
import { RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { Vpc, Peer, Port, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Cluster, FargateTaskDefinition, ContainerImage, LogDrivers, Secret as ECSSecret, FargateService } from 'aws-cdk-lib/aws-ecs';
import { FileSystem, PerformanceMode } from 'aws-cdk-lib/aws-efs';
import { AllowedMethods, CachePolicy, Distribution, OriginProtocolPolicy, OriginRequestPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { LoadBalancerV2Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AwsCustomResource, AwsCustomResourcePolicy } from 'aws-cdk-lib/custom-resources';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

export class OpenWebUIEcsConstruct extends Construct {
    constructor(scope: Construct, id: string) {
        super(scope, id);


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

        // Task Definition
        const taskDefinition = new FargateTaskDefinition(this, 'OpenWebUITaskDef', {
            cpu: 4096,
            memoryLimitMiB: 8192,
        });

        taskDefinition.addToTaskRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['bedrock:*'],
            resources: ['*'],
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

        // Containers
        const openWebUIContainer = taskDefinition.addContainer('openwebui', {
            image: ContainerImage.fromRegistry('ghcr.io/open-webui/open-webui:main'),
            logging: LogDrivers.awsLogs({ streamPrefix: 'openwebui' }),
            environment: {
                DATA_DIR: '/app/backend/data',
                PIPELINES_SERVICE_URL: 'http://localhost:9099',
            },
            secrets: {
                PIPELINES_API_KEY: ECSSecret.fromSecretsManager(apiKeySecret, 'apiKey'),
            },
            essential: true,
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
        const pipelinesAlbSG = new SecurityGroup(this, 'PipelinesAlbSG', { vpc });

        // Allow ALB to access service
        serviceSG.connections.allowFrom(openWebUIAlbSG, Port.tcp(8080));
        serviceSG.connections.allowFrom(pipelinesAlbSG, Port.tcp(9099));

        // Allow CloudFront to access ALBs
        openWebUIAlbSG.addIngressRule(Peer.prefixList(cfPrefixListId), Port.tcp(80));
        pipelinesAlbSG.addIngressRule(Peer.prefixList(cfPrefixListId), Port.tcp(80));

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

        // Load Balancers
        const openWebUIAlb = new ApplicationLoadBalancer(this, 'OpenWebUIAlb', {
            vpc,
            internetFacing: true,
            securityGroup: openWebUIAlbSG,
        });

        const pipelinesAlb = new ApplicationLoadBalancer(this, 'PipelinesAlb', {
            vpc,
            internetFacing: true,
            securityGroup: pipelinesAlbSG,
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


        // ALB Listeners
        openWebUIAlb.addListener('OpenWebUIListener', {
            port: 80,
            protocol: ApplicationProtocol.HTTP,
            defaultTargetGroups: [openWebUITargetGroup],
        });

        pipelinesAlb.addListener('PipelinesListener', {
            port: 80,
            protocol: ApplicationProtocol.HTTP,
            defaultTargetGroups: [pipelinesTargetGroup],
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

        const pipelinesDistribution = new Distribution(this, 'PipelinesDistribution', {
            defaultBehavior: {
                allowedMethods: AllowedMethods.ALLOW_ALL,
                origin: new LoadBalancerV2Origin(pipelinesAlb, {
                    protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
                }),
                originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
                cachePolicy: CachePolicy.CACHING_DISABLED,
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
        });

        // Outputs
        new CfnOutput(this, 'OpenWebUI-CloudFrontDomain', {
            value: openwebuiDistribution.domainName,
            description: 'The CloudFront distribution domain name for Open WebUI.',
        });

        new CfnOutput(this, 'OpenWebUI-Pipelines-CloudFrontDomain', {
            value: pipelinesDistribution.domainName,
            description: 'The CloudFront distribution domain name for the Open WebUI Pipelines service.',
        });
    }
}

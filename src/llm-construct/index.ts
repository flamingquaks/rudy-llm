import { RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { Vpc, Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Cluster, FargateTaskDefinition, ContainerImage, LogDrivers } from 'aws-cdk-lib/aws-ecs';
import { FileSystem, PerformanceMode } from 'aws-cdk-lib/aws-efs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { Distribution, OriginProtocolPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { LoadBalancerV2Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AwsCustomResource, AwsCustomResourcePolicy } from 'aws-cdk-lib/custom-resources';
import { ListenerAction, ListenerCondition, ApplicationListener } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
// import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';

export class OpenWebUIEcsConstruct extends Construct {
    constructor(scope: Construct, id: string) {
        super(scope, id);

        // -----------------------------
        // VPC, Cluster, and EFS Setup
        // -----------------------------
        const vpc = new Vpc(this, 'OpenWebUIVpc', { maxAzs: 2 });
        const cluster = new Cluster(this, 'OpenWebUICluster', { vpc });

        const fileSystem = new FileSystem(this, 'EfsFileSystem', {
            vpc,
            removalPolicy: RemovalPolicy.DESTROY, // Adjust for production
            performanceMode: PerformanceMode.GENERAL_PURPOSE,
        });

        // Allow EFS access from within the VPC.
        fileSystem.connections.allowDefaultPortFrom(Peer.ipv4(vpc.vpcCidrBlock), 'Allow ECS tasks access to EFS');

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
        }))

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

        // Open WebUI container (exposed externally)
        const openWebUIContainer = taskDefinition.addContainer('openwebui', {
            image: ContainerImage.fromRegistry('ghcr.io/open-webui/open-webui:main'),
            logging: LogDrivers.awsLogs({ streamPrefix: 'openwebui' }),
            environment: {
                DATA_DIR: '/app/backend/data',
            },
        });
        openWebUIContainer.addPortMappings({ containerPort: 8080 });
        openWebUIContainer.addMountPoints({
            containerPath: '/app/backend/data',
            sourceVolume: 'openwebuiVolume',
            readOnly: false,
        });

        // Pipelines container (internal only)
        const pipelinesContainer = taskDefinition.addContainer('pipelines', {
            image: ContainerImage.fromRegistry('ghcr.io/open-webui/pipelines:main'),
            logging: LogDrivers.awsLogs({ streamPrefix: 'pipelines' }),
        });
        pipelinesContainer.addMountPoints({
            containerPath: '/app/pipelines',
            sourceVolume: 'pipelinesVolume',
            readOnly: false,
        });

        // -----------------------------
        // ALB Service and Security Group Restriction
        // -----------------------------

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
            installLatestAwsSdk: false, // explicitly disable installing the latest AWS SDK
            policy: AwsCustomResourcePolicy.fromSdkCalls({
                resources: AwsCustomResourcePolicy.ANY_RESOURCE,
            }),
        });
        const cfPrefixListId = cfPrefixListResource.getResponseField('PrefixLists.0.PrefixListId');

        const ecsSg = new SecurityGroup(this, 'EcsSecurityGroup', { vpc });
        // Restrict the ALB's security group to allow inbound traffic only from the CloudFront origin prefix list.
        ecsSg.connections.allowFrom(
            Peer.prefixList(cfPrefixListId),
            Port.tcp(80)
        )
        
        const openWebUISvc = new ApplicationLoadBalancedFargateService(this, 'OpenWebUISvc', {
            cluster,
            openListener: false,
            taskDefinition,
            desiredCount: 1,
            publicLoadBalancer: true,
            assignPublicIp: true,
            minHealthyPercent: 50, // explicitly set to 50 or a value that fits your deployment needs
        });


        // -----------------------------
        // ALB Listener Rule to Require Unique Header
        // -----------------------------
        // Create the listener with a default action for unmatched requests.
        const listener: ApplicationListener = openWebUISvc.listener;

        // Add a high-priority rule that forwards requests when the custom header is present.
        listener.addAction('AllowValidHeader', {
            priority: 1,
            conditions: [
                ListenerCondition.httpHeader('x-unique-header', ['RUDY-LLM-PRIVATE-LINK']),
            ],
            action: ListenerAction.forward([openWebUISvc.targetGroup]),
        });

        // -----------------------------
        // CloudFront Distribution Setup
        // -----------------------------
        // CloudFront adds the custom header to all requests.
        const distribution = new Distribution(this, 'WebUIDistribution', {
            defaultBehavior: {
                origin: new LoadBalancerV2Origin(openWebUISvc.loadBalancer, {
                    protocolPolicy: OriginProtocolPolicy.MATCH_VIEWER,
                    customHeaders: { 'x-unique-header': 'RUDY-LLM-PRIVATE-LINK' },
                }),
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
        });

        // FUTURE TODO
        // // -----------------------------
        // // WAF Setup
        // // -----------------------------
        // const webACL = new CfnWebACL(this, 'WebACL', {
        //     defaultAction: { allow: {} },
        //     scope: 'CLOUDFRONT',
        //     visibilityConfig: {
        //         cloudWatchMetricsEnabled: true,
        //         metricName: 'cloudfrontWebAcl',
        //         sampledRequestsEnabled: true,
        //     },
        //     rules: [],
        // });

        // new CfnWebACLAssociation(this, 'WebACLAssociation', {
        //     resourceArn: distribution.distributionArn,
        //     webAclArn: webACL.attrArn,
        // });

        new CfnOutput(this, 'CloudFrontDomain', {
            value: distribution.domainName,
            description: 'The CloudFront distribution domain name',
        });
    }
}
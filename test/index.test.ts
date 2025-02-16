import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { OpenWebUIEcsStack } from '../src/llm-construct/index';

describe('OpenWebUIEcsStack', () => {
    let app: App;
    let stack: OpenWebUIEcsStack;
    let template: Template;

    beforeAll(() => {
        app = new App();
        stack = new OpenWebUIEcsStack(app, 'TestOpenWebUIEcsStack');
        template = Template.fromStack(stack);
    });

    test('ALB Listener Rule "AllowValidHeader" exists with correct configuration', () => {
        // Check that a ListenerRule is defined with the header condition and priority 1.
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
            Priority: 1,
            Conditions: [
                {
                    Field: "http-header",
                    HttpHeaderConfig: {
                        HttpHeaderName: "x-unique-header",
                        Values: ["RUDY-LLM-PRIVATE-LINK"]
                    }
                }
            ],
        });
    });

    test('CloudFront Distribution has custom header "x-unique-header"', () => {
        // Check that CloudFront distribution includes an origin with the expected custom header.
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: {
                Origins: [
                    {
                        OriginCustomHeaders: [
                            {
                                HeaderName: 'x-unique-header',
                                HeaderValue: 'RUDY-LLM-PRIVATE-LINK'
                            }
                        ]
                    }
                ]
            }
        });
    });

    test('VPC and ECS Cluster are created', () => {
        // Check that one VPC is created.
        template.resourceCountIs('AWS::EC2::VPC', 1);
        // Check that one ECS Cluster is created.
        template.resourceCountIs('AWS::ECS::Cluster', 1);
    });

    test('EFS FileSystem is created with the correct configuration', () => {
        // Check that a FileSystem is created with PerformanceMode GENERAL_PURPOSE.
        template.hasResourceProperties('AWS::EFS::FileSystem', {
            PerformanceMode: "generalPurpose"
        });
    });

    test('ECS Task Definition has required volumes and HTTP Listener has a default fixed response action', () => {
        // Check that the TaskDefinition includes the two volumes: openwebuiVolume and pipelinesVolume.
        template.hasResourceProperties('AWS::ECS::TaskDefinition', {
            Volumes: [
                {
                    Name: 'openwebuiVolume'
                },
                {
                    Name: 'pipelinesVolume'
                }
            ]
        });
        // Check that the HTTP Listener is created with a default fixed response action.
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
            DefaultActions: [
                {
                    FixedResponseConfig: {
                        MessageBody: 'Forbidden',
                        StatusCode: '403',
                        ContentType: 'text/plain'
                    },
                    Type: 'fixed-response'
                }
            ]
        });
    });

    test('CloudFront Distribution output "CloudFrontDomain" is defined', () => {
        // Check that the CloudFront distribution domain output exists.
        template.hasOutput('CloudFrontDomain', {
            Description: 'The CloudFront distribution domain name'
        });
    });
});

describe('OpenWebUIEcsStack Additional Tests', () => {
    let app: App;
    let stack: OpenWebUIEcsStack;
    let template: Template;

    beforeAll(() => {
        app = new App();
        stack = new OpenWebUIEcsStack(app, 'AdditionalTestStack');
        template = Template.fromStack(stack);
    });

    test('ECS Task Definition container definitions are configured correctly', () => {
        template.hasResourceProperties('AWS::ECS::TaskDefinition', {
            ContainerDefinitions: [
                {
                    Name: 'openwebui',
                    Environment: [
                        { Name: 'DATA_DIR', Value: '/app/backend/data' }
                    ],
                    PortMappings: [
                        { ContainerPort: 8080 }
                    ],
                    MountPoints: [{
                        ContainerPath: '/app/backend/data'
                    }]
                },
                {
                    Name: 'pipelines',
                    MountPoints: [{
                        ContainerPath: '/app/pipelines'
                    }]
                }
            ]
        });
    });

    test('ALB is configured as internet-facing', () => {
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
            Scheme: 'internet-facing'
        });
    });

    test('ECS Service has desired count of 1', () => {
        template.hasResourceProperties('AWS::ECS::Service', {
            DesiredCount: 1
        });
    });

    test('HTTP Listener is configured on port 80', () => {
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
            Port: 80
        });
    });
});

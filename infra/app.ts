/**
 * AWS deployment: API Gateway WebSocket API → one Lambda (all routes) →
 * DynamoDB (connections, with a TTL and a by-network index). Pay per use;
 * idles at zero cost.
 *
 *   ALLOWED_ORIGINS=https://example.com,localhost npx cdk deploy
 *
 * Outputs the wss:// URL to give the game (VITE_SIGNAL_URL for Ace of Spades).
 */
import { App, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

export class LanSignalStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { allowedOrigins: string }) {
    super(scope, id, props);
    const table = new Table(this, 'Connections', {
      partitionKey: { name: 'id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expires',
      removalPolicy: RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({ indexName: 'group-index', partitionKey: { name: 'group', type: AttributeType.STRING } });

    const fn = new NodejsFunction(this, 'Relay', {
      entry: fileURLToPath(new URL('../server/lambda.ts', import.meta.url)),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: new LogGroup(this, 'RelayLogs', { retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
      environment: { TABLE: table.tableName, ALLOWED_ORIGINS: props.allowedOrigins },
      bundling: { format: OutputFormat.ESM, externalModules: ['@aws-sdk/*'] },
    });
    table.grantReadWriteData(fn);

    const api = new WebSocketApi(this, 'Api', {
      connectRouteOptions: { integration: new WebSocketLambdaIntegration('ConnectIntegration', fn) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration('DisconnectIntegration', fn) },
      defaultRouteOptions: { integration: new WebSocketLambdaIntegration('MessageIntegration', fn) },
    });
    const stage = new WebSocketStage(this, 'Stage', {
      webSocketApi: api,
      stageName: 'live',
      autoDeploy: true,
      // A safety net against abuse: a few setup messages per player is all a game needs.
      throttle: { rateLimit: 50, burstLimit: 100 },
    });
    api.grantManageConnections(fn);
    new CfnOutput(this, 'SignalUrl', { value: stage.url });
  }
}

const app = new App();
new LanSignalStack(app, 'LanSignal', { allowedOrigins: process.env.ALLOWED_ORIGINS ?? 'localhost' });

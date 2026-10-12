/**
 * AWS Lambda handler for an API Gateway WebSocket API ($connect,
 * $disconnect and $default routes). Connections live in DynamoDB.
 *
 * Environment: TABLE (DynamoDB table name), ALLOWED_ORIGINS (comma-separated,
 * see originAllowed). Clients connect to `wss://…/?app=<app-id>`.
 */
import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResult, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { Relay, RelayError, originAllowed } from '../core/relay.ts';
import type { Connection, ServerMsg, Store } from '../core/relay.ts';

const TABLE = process.env.TABLE ?? '';
const ALLOWED = process.env.ALLOWED_ORIGINS ?? '';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Connections in DynamoDB: key `id`, GSI `group-index` on `group`, TTL on `expires`. */
export class DynamoStore implements Store {
  async get(id: string): Promise<Connection | null> {
    const r = await db.send(new GetCommand({ TableName: TABLE, Key: { id } }));
    return (r.Item as Connection | undefined) ?? null;
  }

  async put(c: Connection): Promise<void> {
    await db.send(new PutCommand({ TableName: TABLE, Item: c }));
  }

  async delete(id: string): Promise<void> {
    await db.send(new DeleteCommand({ TableName: TABLE, Key: { id } }));
  }

  async inGroup(group: string): Promise<Connection[]> {
    const r = await db.send(new QueryCommand({
      TableName: TABLE, IndexName: 'group-index', KeyConditionExpression: '#g = :g', ExpressionAttributeNames: { '#g': 'group' }, ExpressionAttributeValues: { ':g': group },
    }));
    return (r.Items as Connection[] | undefined) ?? [];
  }
}

let api: ApiGatewayManagementApiClient | null = null;

function sender(event: APIGatewayProxyWebsocketEventV2) {
  const { domainName, stage } = event.requestContext;
  api ??= new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
  return async (id: string, msg: ServerMsg): Promise<boolean> => {
    try {
      await api!.send(new PostToConnectionCommand({ ConnectionId: id, Data: new TextEncoder().encode(JSON.stringify(msg)) }));
      return true;
    } catch (e) {
      if (e instanceof GoneException) return false;
      throw e;
    }
  };
}

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & {
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext: { identity?: { sourceIp?: string } };
};

export async function handler(event: ConnectEvent): Promise<APIGatewayProxyResult> {
  const { connectionId, routeKey } = event.requestContext;
  const relay = new Relay(new DynamoStore(), sender(event));
  try {
    if (routeKey === '$connect') {
      const origin = event.headers?.Origin ?? event.headers?.origin;
      if (!originAllowed(origin, ALLOWED)) return { statusCode: 403, body: 'origin not allowed' };
      await relay.connect(connectionId, event.queryStringParameters?.app ?? '', event.requestContext.identity?.sourceIp ?? '');
      return { statusCode: 200, body: '' };
    }
    if (routeKey === '$disconnect') {
      await relay.disconnect(connectionId);
      return { statusCode: 200, body: '' };
    }
    const body = event.body ?? '';
    // Clients say hello first; answering it from $default is the first moment we can post back.
    if (body === '{"t":"hello"}') await relay.hello(connectionId);
    else await relay.message(connectionId, body);
    return { statusCode: 200, body: '' };
  } catch (e) {
    if (e instanceof RelayError) return { statusCode: 400, body: e.message };
    console.error(e);
    return { statusCode: 500, body: 'error' };
  }
}

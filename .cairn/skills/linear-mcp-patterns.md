---
name: Linear MCP Patterns
description: Architectural patterns and conventions for Linear MCP server development
---

# Linear MCP Server Patterns

## Adding New MCP Tools

To add a new Linear tool, follow this pattern:

1. **Define tool in `src/mcp-server.ts`**:
```typescript
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ... existing tools
    {
      name: "mcp__linear__your_new_tool",
      description: "What your tool does",
      inputSchema: {
        type: "object",
        properties: {
          paramName: { type: "string", description: "Parameter description" }
        },
        required: ["paramName"]
      }
    }
  ]
}));
```

2. **Add method to `src/services/linear-service.ts` registry**:
```typescript
private methodHandlers: Record<string, (params: any) => Promise<any>> = {
  // ... existing handlers
  your_new_tool: this.yourNewTool.bind(this),
};
```

3. **Implement the method**:
```typescript
private async yourNewTool(params: any): Promise<any> {
  const { paramName } = params;
  
  // Use identifier resolver for human-readable IDs
  const teamId = await this.identifierResolver.resolveTeamId(params.teamId);
  
  // Execute with retry and rate limiting
  return this.executeWithRetry(async () => {
    const result = await this.linearClient.yourLinearApiCall(teamId);
    return result;
  });
}
```

4. **Add tool dispatch in `src/mcp-server.ts`** CallToolRequest handler:
```typescript
case "mcp__linear__your_new_tool":
  result = await linearService.handleMethod("your_new_tool", params);
  break;
```

## Workspace & Team Resolution Priority

The server resolves workspace and team in this order (first match wins):

### Workspace Resolution
1. `LINEAR_WORKSPACE` environment variable (session override)
2. `.env` file `LINEAR_WORKSPACE` entry
3. **Folder binding** - Longest path prefix match on current directory
4. Active workspace from `~/.linear-mcp/credentials.json`

### Team Resolution  
1. `LINEAR_TEAM` environment variable (session override)
2. `.env` file `LINEAR_TEAM` entry
3. **Folder binding** - Team associated with matched workspace binding
4. `null` (tools must provide teamId)

### Folder Binding Pattern
```typescript
// Bindings stored in credentials.json
{
  "bindings": [
    {
      "path": "/Users/dev/projects/acme-frontend",
      "workspaceUrlKey": "acme",
      "teamKey": "FRONT"
    },
    {
      "path": "/Users/dev/projects/acme-backend", 
      "workspaceUrlKey": "acme",
      "teamKey": "BACK"
    }
  ]
}
```

Longest path match wins - this allows workspace/team auto-injection based on working directory.

## Identifier Resolution Pattern

Human-readable IDs are cached and resolved to UUIDs:

```typescript
// Use identifier resolver for all Linear entities
const teamId = await this.identifierResolver.resolveTeamId("ENG");
const projectId = await this.identifierResolver.resolveProjectId("Q1 Migration");
const stateId = await this.identifierResolver.resolveStateId("ENG", "In Progress");
const labelId = await this.identifierResolver.resolveLabelId("ENG", "Bug");
```

**Cache Strategy**:
- TTL: 5 minutes (300 seconds)
- Cached entities: Teams, Projects, States, Labels
- Cache key includes workspace context
- Auto-refresh on miss

**Pattern**: Always resolve IDs at method entry, before Linear API calls.

## Error Handling & Retry Strategy

### Exponential Backoff
```typescript
executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  return retry(operation, {
    retries: 3,
    minTimeout: 1000,    // 1 second
    maxTimeout: 10000,   // 10 seconds
    factor: 2,           // Exponential backoff
    onFailedAttempt: (error) => {
      this.logger.warn({ 
        attempt: error.attemptNumber,
        retriesLeft: error.retriesLeft 
      }, 'Retrying operation');
    }
  });
}
```

### Rate Limit Detection
```typescript
if (error.message?.includes('Rate limit exceeded')) {
  metrics.linearRateLimitHits.inc();
  throw error; // Will retry with backoff
}
```

### Error Response Format
- **JSON-RPC** (`/rpc`): `{ error: { code, message } }`
- **REST** (other endpoints): HTTP status codes with JSON body

## OAuth & Credentials

### PKCE Flow (No Client Secret)
```typescript
// 1. Generate code verifier
const codeVerifier = generateRandomString(64);
const codeChallenge = base64URLEncode(sha256(codeVerifier));

// 2. Authorization URL
const authUrl = `https://linear.app/oauth/authorize?` +
  `client_id=${clientId}&` +
  `redirect_uri=${redirectUri}&` +
  `response_type=code&` +
  `scope=read,write&` +
  `code_challenge=${codeChallenge}&` +
  `code_challenge_method=S256`;

// 3. Token exchange
const token = await exchangeCodeForToken(code, codeVerifier);
```

### Token Refresh (1-hour buffer)
```typescript
const TOKEN_EXPIRY_BUFFER_MS = 60 * 60 * 1000; // 1 hour

if (Date.now() + TOKEN_EXPIRY_BUFFER_MS >= tokenExpiresAt) {
  await refreshAccessToken(refreshToken);
}
```

Pattern: Always check token expiry before creating LinearClient.

## Logging Conventions

Use structured logging with context-first approach:

```typescript
// Good - context first, message second
this.logger.info({ teamId, workspaceId }, 'Fetching team issues');

// Good - include error object
this.logger.error({ err, teamId }, 'Failed to fetch issues');

// Avoid - string interpolation
this.logger.info(`Fetching issues for team ${teamId}`); // ❌
```

**Log Levels**:
- `error`: Failed operations, exceptions
- `warn`: Retries, rate limits, deprecation
- `info`: Successful operations, state changes  
- `debug`: Detailed execution flow (disabled in production)

## Metrics Collection

Track key operations with Prometheus metrics:

```typescript
// Counter - increment on events
metrics.linearRateLimitHits.inc();

// Histogram - measure duration
const end = metrics.rpcRequestDuration.startTimer({ method });
try {
  const result = await operation();
  end({ status: 'success' });
  return result;
} catch (error) {
  end({ status: 'error' });
  throw error;
}

// Gauge - set current value
metrics.sseConnections.set(activeConnections.size);
```

## Raw GraphQL Fallback

For complex queries that hit Linear SDK limitations:

```typescript
// Use raw GraphQL when needed
private async fetchWithRawGraphQL(query: string, variables: any) {
  const response = await this.linearClient.client.rawRequest(query, variables);
  return response.data;
}
```

**When to use**:
- Query complexity exceeds limits (>10,000)
- Need specific fields not exposed by SDK
- Batch operations that SDK doesn't support

## File Structure Conventions

```
src/
  auth/              - OAuth & credential management
    oauth.ts         - PKCE flow implementation
    credentials.ts   - Multi-workspace credential storage
  
  services/          - Core business logic
    linear-service.ts      - Method registry & handlers
    identifier-resolver.ts - ID caching & resolution
    sse-manager.ts         - Server-Sent Events
  
  handlers/          - Request handlers
    rpc.ts           - JSON-RPC endpoint
    stream.ts        - SSE streaming
    webhook.ts       - Webhook handler
  
  utils/             - Cross-cutting concerns
    logger.ts        - Pino logger setup
    metrics.ts       - Prometheus metrics
    issue-parser.ts  - Issue reference extraction
  
  types/             - TypeScript type definitions
  middleware/        - Express middleware (error handling)
```

## Testing Patterns

```typescript
describe('YourService', () => {
  let service: YourService;
  let mockLinearClient: jest.Mocked<LinearClient>;

  beforeEach(() => {
    mockLinearClient = createMockLinearClient();
    service = new YourService(mockLinearClient);
  });

  it('should handle the expected case', async () => {
    // Arrange
    mockLinearClient.someMethod.mockResolvedValue(expectedData);
    
    // Act
    const result = await service.yourMethod(params);
    
    // Assert
    expect(result).toEqual(expectedOutput);
    expect(mockLinearClient.someMethod).toHaveBeenCalledWith(expectedParams);
  });
});
```

Focus on:
- Service handler registration
- Identifier resolution logic
- Error handling paths
- Issue reference parsing

## Common Patterns Summary

1. **Human-readable IDs**: Always resolve team keys, project names, state names to UUIDs
2. **Auto-injection**: Use folder bindings to auto-fill workspace/team context
3. **Retry everything**: Wrap Linear API calls in `executeWithRetry()`
4. **Cache aggressively**: 5-minute TTL for identifier lookups
5. **Log with context**: Structured logging with Pino
6. **Measure everything**: Prometheus metrics for all operations
7. **Fail gracefully**: Return helpful error messages, not stack traces

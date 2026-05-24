import { LinearClient } from '@linear/sdk';
import pRetry from 'p-retry';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { SSEManager } from './sse-manager';
import { ApiError } from '../middleware/error-handler';
import { JsonRpcErrorCodes } from '../types/json-rpc';
import { IdentifierResolver } from './identifier-resolver';
import { GitUtils } from '../utils/git-utils';
import { IssueParser } from '../utils/issue-parser';

type MethodHandler = (params: any) => Promise<any>;

export class LinearService {
  private client: LinearClient;
  private resolver: IdentifierResolver;
  private methodHandlers: Map<string, MethodHandler> = new Map();

  constructor(apiKey: string, _sseManager: SSEManager) {
    this.client = new LinearClient({ apiKey });
    this.resolver = new IdentifierResolver(this.client);
    this.registerMethods();
  }

  private registerMethods() {
    this.methodHandlers.set('linear.issues.list', this.listIssues.bind(this));
    this.methodHandlers.set('linear.issues.get', this.getIssueMarkdown.bind(this));
    this.methodHandlers.set('linear.issues.create', this.createIssue.bind(this));
    this.methodHandlers.set('linear.issues.update', this.updateIssue.bind(this));
    this.methodHandlers.set('linear.issues.delete', this.deleteIssue.bind(this));
    this.methodHandlers.set('linear.issues.search', this.searchIssues.bind(this));

    this.methodHandlers.set('linear.comments.list', this.listComments.bind(this));
    this.methodHandlers.set('linear.comments.create', this.createComment.bind(this));

    this.methodHandlers.set('linear.projects.list', this.listProjects.bind(this));
    this.methodHandlers.set('linear.projects.get', this.getProject.bind(this));
    this.methodHandlers.set('linear.projects.create', this.createProject.bind(this));
    this.methodHandlers.set('linear.projects.update', this.updateProject.bind(this));

    this.methodHandlers.set('linear.cycles.list', this.listCycles.bind(this));
    this.methodHandlers.set('linear.cycles.get', this.getCycle.bind(this));

    this.methodHandlers.set('linear.teams.list', this.listTeams.bind(this));
    this.methodHandlers.set('linear.teams.get', this.getTeam.bind(this));

    this.methodHandlers.set('linear.states.list', this.listStates.bind(this));
    this.methodHandlers.set('linear.labels.list', this.listLabels.bind(this));

    this.methodHandlers.set('linear.users.list', this.listUsers.bind(this));
    this.methodHandlers.set('linear.users.get', this.getUser.bind(this));
    this.methodHandlers.set('linear.users.me', this.getCurrentUser.bind(this));

    this.methodHandlers.set('linear.capabilities', this.getCapabilities.bind(this));
    this.methodHandlers.set('linear.file_history', this.getFileHistory.bind(this));
  }

  getMethodHandler(method: string): MethodHandler | undefined {
    return this.methodHandlers.get(method);
  }

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    const startTime = Date.now();

    try {
      const result = await pRetry(
        async () => {
          try {
            return await operation();
          } catch (error: any) {
            if (error.response?.status === 429) {
              metrics.linearRateLimited.inc();
              const retryAfter = error.response.headers['retry-after'];
              if (retryAfter) {
                const waitTime = parseInt(retryAfter) * 1000;
                logger.warn({ waitTime, operationName }, 'Rate limited by Linear API');
                await new Promise(resolve => setTimeout(resolve, waitTime));
              }
            }
            throw error;
          }
        },
        {
          retries: 3,
          minTimeout: 1000,
          maxTimeout: 10000,
          onFailedAttempt: (error) => {
            logger.warn({
              attempt: error.attemptNumber,
              retriesLeft: error.retriesLeft,
              error: error.message,
              operationName,
            }, 'Retry attempt failed');
          },
        }
      );

      const duration = Date.now() - startTime;
      metrics.linearApiLatency.observe({ operation: operationName }, duration);

      return result;
    } catch (error: any) {
      logger.error({ error, operationName }, 'Linear API operation failed');
      throw new ApiError(
        500,
        `Linear API error: ${error.message}`,
        JsonRpcErrorCodes.SERVER_ERROR,
        { originalError: error.message }
      );
    }
  }

  public async listIssues(params: any) {
    const { teamId, projectId, cycleId, assigneeId, stateId, limit = 50 } = params;

    return this.executeWithRetry(async () => {
      const resolvedTeamId = teamId ? await this.resolver.resolveTeamId(teamId) : undefined;
      const resolvedProjectId = projectId ? await this.resolver.resolveProjectId(projectId, resolvedTeamId) : undefined;
      const resolvedAssigneeId = assigneeId ? await this.resolver.resolveUserId(assigneeId) : undefined;
      const resolvedStateId = stateId && resolvedTeamId ? await this.resolver.resolveStateId(stateId, resolvedTeamId) : undefined;

      const viewer = await this.client.viewer;
      
      if (!viewer.id) {
        throw new ApiError(500, 'Unable to get current user ID for membership field', JsonRpcErrorCodes.SERVER_ERROR);
      }
      // Access the underlying Apollo client and use the SDK's pre-built query
      const apolloClient = (this.client as any).client;
      const issuesDocument = (this.client as any).documents?.issues;

      if (!issuesDocument) {
        // Fallback to raw query if documents not available
        const query = `
          query ListIssues($first: Int!, $filter: IssueFilter) {
            issues(first: $first, filter: $filter) {
              nodes {
                identifier
                title
                createdAt
                updatedAt
                priority
                estimate
                state {
                  name
                }
                labels {
                  nodes {
                    name
                  }
                }
              }
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
            }
          }
        `;

        const filter: any = {};
        if (resolvedTeamId) filter.team = { id: { eq: resolvedTeamId } };
        if (resolvedProjectId) filter.project = { id: { eq: resolvedProjectId } };
        if (cycleId) filter.cycle = { id: { eq: cycleId } };
        if (resolvedAssigneeId) filter.assignee = { id: { eq: resolvedAssigneeId } };
        if (resolvedStateId) filter.state = { id: { eq: resolvedStateId } };

        const response = await apolloClient.rawRequest(query, {
          first: limit,
          filter: Object.keys(filter).length > 0 ? filter : undefined
        });

        const transformedNodes = response.data.issues.nodes.map((issue: any) => ({
          identifier: issue.identifier,
          title: issue.title,
          lastUpdate: new Date(issue.updatedAt).toLocaleDateString(),
          priority: issue.priority,
          estimate: issue.estimate,
          status: issue.state?.name || 'Unknown',
          labels: issue.labels?.nodes?.map((label: any) => label.name) || [],
        }));

        return {
          nodes: transformedNodes,
          pageInfo: response.data.issues.pageInfo,
          table: this.formatIssuesAsMarkdownTable(transformedNodes),
        };
      }

      // Use the SDK's pre-built query with proper variables
      const variables = {
        first: limit,
        filter: {
          team: resolvedTeamId ? { id: { eq: resolvedTeamId } } : undefined,
          project: resolvedProjectId ? { id: { eq: resolvedProjectId } } : undefined,
          cycle: cycleId ? { id: { eq: cycleId } } : undefined,
          assignee: resolvedAssigneeId ? { id: { eq: resolvedAssigneeId } } : undefined,
          state: resolvedStateId ? { id: { eq: resolvedStateId } } : undefined,
        },
        userId: viewer.id,  // This should satisfy the membership field
        includeArchived: false
      };

      // Remove undefined filter values
      Object.keys(variables.filter).forEach(key => {
        if ((variables.filter as any)[key] === undefined) {
          delete (variables.filter as any)[key];
        }
      });

      const response = await apolloClient.query({
        query: issuesDocument,
        variables
      });

      const transformedNodes = response.data.issues.nodes.map((issue: any) => ({
        identifier: issue.identifier,
        title: issue.title,
        lastUpdate: new Date(issue.updatedAt).toLocaleDateString(),
        priority: issue.priority,
        estimate: issue.estimate,
        status: issue.state?.name || 'Unknown',
        labels: issue.labels?.nodes?.map((label: any) => label.name) || [],
      }));

      return {
        nodes: transformedNodes,
        pageInfo: response.data.issues.pageInfo,
        table: this.formatIssuesAsMarkdownTable(transformedNodes),
      };
    }, 'listIssues');
  }

  private formatIssuesAsMarkdownTable(issues: any[]): string {
    if (issues.length === 0) {
      return '*No issues found*';
    }

    let table = '| ID | Title | Status | Labels | Priority | Updated |\n';
    table += '|---|---|---|---|---|---|\n';

    issues.forEach(issue => {
      const priorityText = issue.priority === 0 ? 'None' : 
                          issue.priority === 1 ? 'Urgent' :
                          issue.priority === 2 ? 'High' :
                          issue.priority === 3 ? 'Normal' : 'Low';
      const labelsText = issue.labels.length > 0 ? issue.labels.join(', ') : '-';
      
      table += `| ${issue.identifier} | ${issue.title} | ${issue.status} | ${labelsText} | ${priorityText} | ${issue.lastUpdate} |\n`;
    });

    return table;
  }

  public async searchIssues(params: any) {
    const { 
      query, 
      teamId, 
      stateId, 
      labelIds, 
      createdAfter, 
      updatedAfter,
      includeArchived = false,
      limit = 50 
    } = params;

    if (!query) {
      throw new ApiError(400, 'Search query is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      // Resolve identifiers to UUIDs
      const resolvedTeamId = teamId ? await this.resolver.resolveTeamId(teamId) : undefined;
      const resolvedStateId = stateId && resolvedTeamId ? await this.resolver.resolveStateId(stateId, resolvedTeamId) : undefined;
      const resolvedLabelIds = labelIds && resolvedTeamId ? await this.resolver.resolveLabelIds(labelIds, resolvedTeamId) : undefined;

      // Build the GraphQL query for search
      const searchQuery = `
        query SearchIssues($first: Int!, $term: String!, $filter: IssueFilter, $includeArchived: Boolean!) {
          searchIssues(first: $first, term: $term, filter: $filter, includeArchived: $includeArchived) {
            nodes {
              id
              identifier
              title
              description
              url
              createdAt
              updatedAt
              priority
              estimate
              state {
                name
                type
              }
              assignee {
                name
                email
              }
              team {
                key
                name
              }
              labels {
                nodes {
                  name
                  color
                }
              }
              project {
                name
              }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
          }
        }
      `;

      // Build filter object
      const filter: any = {};
      if (resolvedTeamId) filter.team = { id: { eq: resolvedTeamId } };
      if (resolvedStateId) filter.state = { id: { eq: resolvedStateId } };
      if (resolvedLabelIds && resolvedLabelIds.length > 0) {
        filter.labels = { some: { id: { in: resolvedLabelIds } } };
      }
      if (createdAfter) filter.createdAt = { gte: createdAfter };
      if (updatedAfter) filter.updatedAt = { gte: updatedAfter };

      const variables = {
        first: limit,
        term: query,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        includeArchived
      };

      const response = await (this.client as any).client.rawRequest(searchQuery, variables);
      const searchResults = response.data.searchIssues;

      // Transform the results to match the expected format
      const transformedNodes = searchResults.nodes.map((issue: any) => ({
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ? 
          (issue.description.length > 200 ? issue.description.substring(0, 200) + '...' : issue.description) : 
          '',
        url: issue.url,
        lastUpdate: new Date(issue.updatedAt).toLocaleDateString(),
        priority: issue.priority,
        estimate: issue.estimate,
        status: issue.state?.name || 'Unknown',
        stateType: issue.state?.type,
        assignee: issue.assignee?.name || 'Unassigned',
        team: `${issue.team?.name} (${issue.team?.key})`,
        labels: issue.labels?.nodes?.map((label: any) => label.name) || [],
        project: issue.project?.name || null,
      }));

      // Format results as a detailed table
      let resultTable = `## Search Results for: "${query}"\n\n`;
      resultTable += `Found ${transformedNodes.length} issues${limit && transformedNodes.length >= limit ? ' (limited)' : ''}\n\n`;
      
      if (transformedNodes.length === 0) {
        resultTable += '*No issues found matching your search criteria*\n';
      } else {
        resultTable += '| ID | Title | Team | Status | Assignee | Labels | Updated |\n';
        resultTable += '|---|---|---|---|---|---|---|\n';
        
        transformedNodes.forEach((issue: any) => {
          const labelsText = issue.labels.length > 0 ? issue.labels.join(', ') : '-';
          const title = issue.title.length > 50 ? issue.title.substring(0, 50) + '...' : issue.title;
          
          resultTable += `| ${issue.identifier} | ${title} | ${issue.team} | ${issue.status} | ${issue.assignee} | ${labelsText} | ${issue.lastUpdate} |\n`;
        });
      }

      return {
        nodes: transformedNodes,
        pageInfo: searchResults.pageInfo,
        table: resultTable,
        query,
        filters: {
          team: teamId || null,
          state: stateId || null,
          labels: labelIds || null,
          createdAfter: createdAfter || null,
          updatedAfter: updatedAfter || null,
        }
      };
    }, 'searchIssues');
  }


  public async createIssue(params: any) {
    const { title, description, teamId, projectId, cycleId, assigneeId, stateId, priority, estimate, labelIds } = params;

    if (!title || !teamId) {
      throw new ApiError(400, 'Title and teamId are required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      // Resolve identifiers to UUIDs
      const resolvedTeamId = await this.resolver.resolveTeamId(teamId);
      const resolvedProjectId = projectId ? await this.resolver.resolveProjectId(projectId, resolvedTeamId) : undefined;
      const resolvedAssigneeId = assigneeId ? await this.resolver.resolveUserId(assigneeId) : undefined;
      const resolvedStateId = stateId ? await this.resolver.resolveStateId(stateId, resolvedTeamId) : undefined;
      const resolvedLabelIds = labelIds ? await this.resolver.resolveLabelIds(labelIds, resolvedTeamId) : undefined;
      // Title must fit in 255 chars - if it doesn't, we have a problem
      if (title.length > 255) {
        throw new ApiError(400, `Title too long (${title.length} chars). Maximum is 255 characters.`, JsonRpcErrorCodes.INVALID_PARAMS);
      }

      // Check if description needs chunking
      if (description && description.length > 65000) {
        // Create issue with first chunk
        const chunks = this.smartChunkText(description, 65000);
        const firstChunkWithNote = chunks[0] + '\n\n[Note: This issue description was split into multiple comments due to size limits]';

        const issuePayload = await this.client.createIssue({
          title,
          description: firstChunkWithNote,
          teamId: resolvedTeamId,
          projectId: resolvedProjectId,
          cycleId,
          assigneeId: resolvedAssigneeId,
          stateId: resolvedStateId,
          priority,
          estimate,
          labelIds: resolvedLabelIds,
          parentId: params.parentId,
        });

        const issue = await issuePayload.issue;
        if (!issue) {
          throw new ApiError(500, 'Failed to create issue', JsonRpcErrorCodes.SERVER_ERROR);
        }

        // Add remaining chunks as comments
        for (let i = 1; i < chunks.length; i++) {
          const header = `[Description Part ${i + 1}/${chunks.length}]\n\n`;
          const footer = i < chunks.length - 1 ? '\n\n[Continued in next comment...]' : '';
          const chunkContent = header + chunks[i] + footer;

          await this.client.createComment({
            issueId: issue.id,
            body: chunkContent,
          });

          // Small delay to avoid rate limiting
          if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        return {
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          chunked: true,
          chunks: chunks.length,
        };
      } else {
        // Normal issue creation
        const issuePayload = await this.client.createIssue({
          title,
          description,
          teamId: resolvedTeamId,
          projectId: resolvedProjectId,
          cycleId,
          assigneeId: resolvedAssigneeId,
          stateId: resolvedStateId,
          priority,
          estimate,
          labelIds: resolvedLabelIds,
          parentId: params.parentId,
        });

        const issue = await issuePayload.issue;
        if (!issue) {
          throw new ApiError(500, 'Failed to create issue', JsonRpcErrorCodes.SERVER_ERROR);
        }

        return {
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
        };
      }
    }, 'createIssue');
  }

  public async updateIssue(params: any) {
    const { id, ...updateData } = params;

    if (!id) {
      throw new ApiError(400, 'Issue ID is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    if (updateData.title && updateData.title.length > 255) {
      throw new ApiError(400, `Title too long (${updateData.title.length} chars). Maximum is 255 characters.`, JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      // Resolve issue identifier to UUID
      const resolvedIssueId = await this.resolver.resolveIssueId(id);

      // Get the issue to find its team ID for state/label resolution
      let teamId: string | undefined;
      if (updateData.stateId || updateData.labelIds) {
        // Use raw GraphQL to avoid membership field issue
        const query = `
          query GetIssueTeam($issueId: String!) {
            issue(id: $issueId) {
              id
              team {
                id
              }
            }
          }
        `;
        
        const response = await (this.client as any).client.rawRequest(query, { issueId: resolvedIssueId });
        const issue = response.data.issue;
        
        if (!issue) {
          throw new ApiError(404, 'Issue not found', JsonRpcErrorCodes.SERVER_ERROR);
        }
        teamId = issue.team?.id;
      }

      // Resolve other identifiers if provided
      const resolvedProjectId = updateData.projectId ? await this.resolver.resolveProjectId(updateData.projectId) : undefined;
      const resolvedAssigneeId = updateData.assigneeId ? await this.resolver.resolveUserId(updateData.assigneeId) : undefined;
      const resolvedStateId = updateData.stateId && teamId ? await this.resolver.resolveStateId(updateData.stateId, teamId) : undefined;
      const resolvedLabelIds = updateData.labelIds && teamId ? await this.resolver.resolveLabelIds(updateData.labelIds, teamId) : undefined;

      const resolvedUpdateData = {
        ...updateData,
        projectId: resolvedProjectId,
        assigneeId: resolvedAssigneeId,
        stateId: resolvedStateId,
        labelIds: resolvedLabelIds,
      };
      // Handle large descriptions
      if (updateData.description && updateData.description.length > 65000) {
        const chunks = this.smartChunkText(updateData.description, 65000);

        // Update with first chunk and note
        const firstChunkWithNote = chunks[0] + '\n\n[Note: This issue description was split into multiple comments due to size limits]';
        const updatePayload = await this.client.updateIssue(resolvedIssueId, {
          ...resolvedUpdateData,
          description: firstChunkWithNote,
        });

        const issue = await updatePayload.issue;
        if (!issue) {
          throw new ApiError(500, 'Failed to update issue', JsonRpcErrorCodes.SERVER_ERROR);
        }

        // Add remaining chunks as comments
        for (let i = 1; i < chunks.length; i++) {
          const header = `[Updated Description Part ${i + 1}/${chunks.length}]\n\n`;
          const footer = i < chunks.length - 1 ? '\n\n[Continued in next comment...]' : '';
          const chunkContent = header + chunks[i] + footer;

          await this.client.createComment({
            issueId: issue.id,
            body: chunkContent,
          });

          if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        return {
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          success: updatePayload.success,
          chunked: true,
          chunks: chunks.length,
        };
      } else {
        // Normal update
        // Use raw GraphQL when stateId is present to avoid membership field issue
        if (resolvedUpdateData.stateId) {
          // Build the input object for the mutation
          const input: any = {};
          if (resolvedUpdateData.title !== undefined) input.title = resolvedUpdateData.title;
          if (resolvedUpdateData.description !== undefined) input.description = resolvedUpdateData.description;
          if (resolvedUpdateData.stateId !== undefined) input.stateId = resolvedUpdateData.stateId;
          if (resolvedUpdateData.assigneeId !== undefined) input.assigneeId = resolvedUpdateData.assigneeId;
          if (resolvedUpdateData.priority !== undefined) input.priority = resolvedUpdateData.priority;
          if (resolvedUpdateData.dueDate !== undefined) input.dueDate = resolvedUpdateData.dueDate;
          if (resolvedUpdateData.projectId !== undefined) input.projectId = resolvedUpdateData.projectId;
          if (resolvedUpdateData.cycleId !== undefined) input.cycleId = resolvedUpdateData.cycleId;
          if (resolvedUpdateData.parentId !== undefined) input.parentId = resolvedUpdateData.parentId;
          if (resolvedUpdateData.labelIds !== undefined) input.labelIds = resolvedUpdateData.labelIds;
          if (resolvedUpdateData.estimate !== undefined) input.estimate = resolvedUpdateData.estimate;
          
          const mutation = `
            mutation UpdateIssue($issueId: String!, $input: IssueUpdateInput!) {
              issueUpdate(
                id: $issueId,
                input: $input
              ) {
                success
                issue {
                  id
                  identifier
                  title
                  url
                }
              }
            }
          `;
          
          const response = await (this.client as any).client.rawRequest(mutation, {
            issueId: resolvedIssueId,
            input,
          });
          
          const updateResult = response.data.issueUpdate;
          if (!updateResult.success) {
            throw new ApiError(500, 'Failed to update issue', JsonRpcErrorCodes.SERVER_ERROR);
          }
          
          return {
            identifier: updateResult.issue.identifier,
            title: updateResult.issue.title,
            url: updateResult.issue.url,
            success: updateResult.success,
          };
        } else {
          // Use SDK for other updates
          const updatePayload = await this.client.updateIssue(resolvedIssueId, resolvedUpdateData);
          const issue = await updatePayload.issue;

          if (!issue) {
            throw new ApiError(500, 'Failed to update issue', JsonRpcErrorCodes.SERVER_ERROR);
          }

          return {
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
            success: updatePayload.success,
          };
        }
      }
    }, 'updateIssue');
  }

  public async deleteIssue(params: any) {
    const { id } = params;

    if (!id) {
      throw new ApiError(400, 'Issue ID is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const resolvedIssueId = await this.resolver.resolveIssueId(id);
      const archivePayload = await this.client.archiveIssue(resolvedIssueId);
      return {
        success: archivePayload.success,
      };
    }, 'deleteIssue');
  }

  public async getIssueMarkdown(params: any) {
    const { id } = params;

    if (!id) {
      throw new ApiError(400, 'Issue ID or identifier is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      // Resolve the identifier to UUID
      const issueId = await this.resolver.resolveIssueId(id);

      // Now fetch the full issue with a simpler query
      const issueQuery = `
        query IssueById($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            createdAt
            updatedAt
            priority
            state {
              name
            }
            project {
              name
            }
            team {
              name
              key
            }
          }
        }
      `;

      const issueResponse = await (this.client as any).client.rawRequest(issueQuery, { id: issueId });
      const issue = issueResponse.data.issue;

      if (!issue) {
        throw new ApiError(404, `Issue ${id} not found`, JsonRpcErrorCodes.SERVER_ERROR);
      }

      // Fetch labels separately
      const labelsQuery = `
        query IssueLabels($id: String!) {
          issue(id: $id) {
            labels {
              nodes {
                name
              }
            }
          }
        }
      `;

      const labelsResponse = await (this.client as any).client.rawRequest(labelsQuery, { id: issueId });
      const labels = labelsResponse.data.issue?.labels?.nodes || [];

      // Fetch comments separately
      const commentsQuery = `
        query IssueComments($id: String!) {
          issue(id: $id) {
            comments {
              nodes {
                id
                body
                createdAt
                user {
                  name
                }
              }
            }
          }
        }
      `;

      const commentsResponse = await (this.client as any).client.rawRequest(commentsQuery, { id: issueId });
      const comments = commentsResponse.data.issue?.comments?.nodes || [];

      // Format as markdown
      let markdown = `# ${issue.identifier}: ${issue.title}\n\n`;

      // Metadata
      markdown += `**Status:** ${issue.state?.name || 'Unknown'}\n`;
      
      // Format priority
      const priorityText = issue.priority === 0 ? 'None' : 
                          issue.priority === 1 ? 'Urgent' :
                          issue.priority === 2 ? 'High' :
                          issue.priority === 3 ? 'Normal' : 'Low';
      markdown += `**Priority:** ${priorityText}\n`;
      
      if (labels.length > 0) {
        markdown += `**Labels:** ${labels.map((l: any) => l.name).join(', ')}\n`;
      }
      
      if (issue.project) markdown += `**Project:** ${issue.project.name}\n`;
      markdown += `**Team:** ${issue.team?.name || 'Unknown'} (${issue.team?.key || ''})\n`;
      markdown += `**Created:** ${new Date(issue.createdAt).toLocaleString()}\n`;
      markdown += `**Updated:** ${new Date(issue.updatedAt).toLocaleString()}\n\n`;

      // Description
      markdown += `## Description\n\n`;
      markdown += issue.description || '*No description provided*';
      markdown += '\n\n';

      // Comments
      if (comments.length > 0) {
        markdown += `## Comments (${comments.length})\n\n`;
        for (const comment of comments) {
          markdown += `---\n\n`;
          markdown += `**${comment.user?.name || 'Unknown'}** - ${new Date(comment.createdAt).toLocaleString()}\n\n`;
          markdown += comment.body || '*Empty comment*';
          markdown += '\n\n';
        }
      } else {
        markdown += `## Comments\n\n*No comments yet*\n\n`;
      }

      return {
        markdown,
        issueId: issue.id,
        identifier: issue.identifier,
      };
    }, 'getIssueMarkdown');
  }

  public async listComments(params: any) {
    const { issueId } = params;

    if (!issueId) {
      throw new ApiError(400, 'Issue ID is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const resolvedIssueId = await this.resolver.resolveIssueId(issueId);
      const issue = await this.client.issue(resolvedIssueId);
      if (!issue) {
        throw new ApiError(404, 'Issue not found', JsonRpcErrorCodes.SERVER_ERROR);
      }

      const comments = await issue.comments();

      // Sort comments by creation date and add position
      const sortedComments = comments.nodes.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      return {
        nodes: await Promise.all(sortedComments.map(async (comment, index) => ({
          position: index + 1,
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          user: await comment.user,
        }))),
      };
    }, 'listComments');
  }

  public async createComment(params: any) {
    const { issueId, body } = params;

    if (!issueId || !body) {
      throw new ApiError(400, 'Issue ID and body are required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const resolvedIssueId = await this.resolver.resolveIssueId(issueId);
      if (body.length <= 65000) {
        // Single comment
        const commentPayload = await this.client.createComment({
          issueId: resolvedIssueId,
          body,
        });

        const comment = await commentPayload.comment;
        if (!comment) {
          throw new ApiError(500, 'Failed to create comment', JsonRpcErrorCodes.SERVER_ERROR);
        }

        // Get position by fetching all comments
        const issue = await this.client.issue(resolvedIssueId);
        const allComments = await issue.comments();
        const sortedComments = allComments.nodes.sort((a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        const position = sortedComments.findIndex(c => c.id === comment.id) + 1;

        return {
          position,
          body: comment.body,
          createdAt: comment.createdAt,
        };
      } else {
        // Split into multiple comments
        const chunks = this.smartChunkText(body, 65000);
        const comments = [];

        for (let i = 0; i < chunks.length; i++) {
          const header = chunks.length > 1 ? `[Comment Part ${i + 1}/${chunks.length}]\n\n` : '';
          const footer = i < chunks.length - 1 ? '\n\n[Continued in next comment...]' : '';
          const chunkContent = header + chunks[i] + footer;

          const commentPayload = await this.client.createComment({
            issueId: resolvedIssueId,
            body: chunkContent,
          });

          const comment = await commentPayload.comment;
          if (!comment) {
            throw new ApiError(500, `Failed to create comment part ${i + 1}`, JsonRpcErrorCodes.SERVER_ERROR);
          }

          comments.push({
            body: comment.body,
            createdAt: comment.createdAt,
            part: i + 1,
            totalParts: chunks.length,
          });

          if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        // Get positions for all created comments
        const issue = await this.client.issue(resolvedIssueId);
        const allComments = await issue.comments();
        const sortedComments = allComments.nodes.sort((a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );

        // Add positions to created comments
        const commentsWithPositions = comments.map(comment => {
          const position = sortedComments.findIndex(c =>
            c.body === comment.body && c.createdAt === comment.createdAt
          ) + 1;
          return { ...comment, position };
        });

        return {
          chunked: true,
          totalParts: chunks.length,
          comments: commentsWithPositions,
        };
      }
    }, 'createComment');
  }

  public async listProjects(params: any) {
    const { limit = 50 } = params;

    return this.executeWithRetry(async () => {
      // Use raw GraphQL query to avoid membership field issue
      const query = `
        query ListProjects($first: Int!) {
          projects(first: $first) {
            nodes {
              id
              name
              description
              url
              createdAt
              updatedAt
              startDate
              targetDate
              teams {
                nodes {
                  key
                  name
                }
              }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
          }
        }
      `;

      const response = await (this.client as any).client.rawRequest(query, { first: limit });
      const projects = response.data.projects;

      return {
        nodes: projects.nodes.map((project: any) => ({
          name: project.name,
          description: project.description,
          url: project.url,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          startDate: project.startDate,
          targetDate: project.targetDate,
          teams: project.teams.nodes.map((team: any) => ({
            key: team.key,
            name: team.name,
          })),
        })),
        pageInfo: projects.pageInfo,
      };
    }, 'listProjects');
  }

  public async getProject(params: any) {
    const { id } = params;

    if (!id) {
      throw new ApiError(400, 'Project ID is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const resolvedProjectId = await this.resolver.resolveProjectId(id);
      
      // Use raw GraphQL query to avoid membership field issue
      const query = `
        query GetProject($id: String!) {
          project(id: $id) {
            id
            name
            description
            url
            createdAt
            updatedAt
            startDate
            targetDate
            teams {
              nodes {
                key
                name
              }
            }
            issues(first: 50) {
              nodes {
                identifier
                title
              }
            }
          }
        }
      `;

      const response = await (this.client as any).client.rawRequest(query, { id: resolvedProjectId });
      const project = response.data.project;
      
      if (!project) {
        throw new ApiError(404, 'Project not found', JsonRpcErrorCodes.SERVER_ERROR);
      }

      return {
        name: project.name,
        description: project.description,
        url: project.url,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        startDate: project.startDate,
        targetDate: project.targetDate,
        teams: project.teams.nodes.map((team: any) => ({
          key: team.key,
          name: team.name,
        })),
        issues: project.issues.nodes.map((issue: any) => ({
          identifier: issue.identifier,
          title: issue.title,
        })),
      };
    }, 'getProject');
  }

  public async createProject(params: any) {
    const { name, description, teamIds, startDate, targetDate } = params;

    if (!name || !teamIds || teamIds.length === 0) {
      throw new ApiError(400, 'Name and at least one teamId are required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      // Resolve team keys to IDs
      const resolvedTeamIds = await Promise.all(
        teamIds.map((teamId: string) => this.resolver.resolveTeamId(teamId))
      );
      if (name.length > 255) {
        throw new ApiError(400, `Project name too long (${name.length} chars). Maximum is 255 characters.`, JsonRpcErrorCodes.INVALID_PARAMS);
      }

      if (description && description.length > 65000) {
        throw new ApiError(400, `Project description too long (${description.length} chars). Maximum is 65000 characters. Consider creating a linked document for detailed information.`, JsonRpcErrorCodes.INVALID_PARAMS);
      }

      const projectPayload = await this.client.createProject({
        name,
        description,
        teamIds: resolvedTeamIds,
        startDate,
        targetDate,
      });

      const project = await projectPayload.project;
      if (!project) {
        throw new ApiError(500, 'Failed to create project', JsonRpcErrorCodes.SERVER_ERROR);
      }

      return {
        name: project.name,
        url: project.url,
      };
    }, 'createProject');
  }

  public async updateProject(params: any) {
    const { id, ...updateData } = params;

    if (!id) {
      throw new ApiError(400, 'Project ID is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    const resolvedProjectId = await this.resolver.resolveProjectId(id);

    if (updateData.name && updateData.name.length > 255) {
      throw new ApiError(400, `Project name too long (${updateData.name.length} chars). Maximum is 255 characters.`, JsonRpcErrorCodes.INVALID_PARAMS);
    }

    // For projects, we can't split descriptions into comments, so we need to warn
    if (updateData.description && updateData.description.length > 65000) {
      throw new ApiError(400, `Project description too long (${updateData.description.length} chars). Maximum is 65000 characters. Consider creating a linked document for detailed information.`, JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const updatePayload = await this.client.updateProject(resolvedProjectId, updateData);
      const project = await updatePayload.project;

      if (!project) {
        throw new ApiError(500, 'Failed to update project', JsonRpcErrorCodes.SERVER_ERROR);
      }

      return {
        name: project.name,
        url: project.url,
        success: updatePayload.success,
      };
    }, 'updateProject');
  }

  private async listCycles(params: any) {
    const { teamId, limit = 50 } = params;

    return this.executeWithRetry(async () => {
      const resolvedTeamId = teamId ? await this.resolver.resolveTeamId(teamId) : undefined;
      const cycles = await this.client.cycles({
        filter: resolvedTeamId ? { team: { id: { eq: resolvedTeamId } } } : undefined,
        first: limit,
      });

      return {
        nodes: await Promise.all(cycles.nodes.map(async (cycle) => {
          const team = await cycle.team;
          return {
            number: cycle.number,
            name: cycle.name,
            startsAt: cycle.startsAt,
            endsAt: cycle.endsAt,
            team: {
              key: team?.key || '',
              name: team?.name || '',
            },
          };
        })),
        pageInfo: cycles.pageInfo,
      };
    }, 'listCycles');
  }

  private async getCycle(params: any) {
    const { id } = params;

    if (!id) {
      throw new ApiError(400, 'Cycle ID is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const cycle = await this.client.cycle(id);
      if (!cycle) {
        throw new ApiError(404, 'Cycle not found', JsonRpcErrorCodes.SERVER_ERROR);
      }

      const team = await cycle.team;
      return {
        number: cycle.number,
        name: cycle.name,
        startsAt: cycle.startsAt,
        endsAt: cycle.endsAt,
        team: {
          key: team?.key || '',
          name: team?.name || '',
        },
        issues: await cycle.issues().then(i => i.nodes.map(issue => ({
          identifier: issue.identifier,
          title: issue.title,
        }))),
      };
    }, 'getCycle');
  }

  public async listTeams(params: any) {
    const { limit = 50 } = params;

    return this.executeWithRetry(async () => {
      // Use raw GraphQL query to avoid SDK's automatic field inclusion
      const query = `
        query Teams($first: Int!) {
          teams(first: $first) {
            nodes {
              id
              key
              name
              description
              createdAt
              updatedAt
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
          }
        }
      `;

      const response = await (this.client as any).client.rawRequest(query, { first: limit });

      return {
        nodes: response.data.teams.nodes.map((team: any) => ({
          key: team.key,
          name: team.name,
          description: team.description,
          createdAt: team.createdAt,
          updatedAt: team.updatedAt,
        })),
        pageInfo: response.data.teams.pageInfo,
      };
    }, 'listTeams');
  }

  public async getTeam(params: any) {
    const { id } = params;

    if (!id) {
      throw new ApiError(400, 'Team ID is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const resolvedTeamId = await this.resolver.resolveTeamId(id);
      
      // Use raw GraphQL query to avoid membership field issue
      const query = `
        query GetTeam($id: String!) {
          team(id: $id) {
            id
            key
            name
            description
            createdAt
            updatedAt
          }
        }
      `;

      const response = await (this.client as any).client.rawRequest(query, { id: resolvedTeamId });
      const team = response.data.team;
      
      if (!team) {
        throw new ApiError(404, 'Team not found', JsonRpcErrorCodes.SERVER_ERROR);
      }

      return {
        key: team.key,
        name: team.name,
        description: team.description,
        createdAt: team.createdAt,
        updatedAt: team.updatedAt,
      };
    }, 'getTeam');
  }

  public async listStates(params: any) {
    const { teamId } = params;

    if (!teamId) {
      throw new ApiError(400, 'Team ID or key is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const resolvedTeamId = await this.resolver.resolveTeamId(teamId);
      
      const query = `
        query TeamStates($teamId: String!) {
          team(id: $teamId) {
            key
            name
            states {
              nodes {
                name
                type
                color
                position
                description
              }
            }
          }
        }
      `;

      const response = await (this.client as any).client.rawRequest(query, { teamId: resolvedTeamId });
      const team = response.data.team;
      
      if (!team) {
        throw new ApiError(404, 'Team not found', JsonRpcErrorCodes.SERVER_ERROR);
      }

      return {
        team: {
          key: team.key,
          name: team.name,
        },
        states: team.states.nodes.map((state: any) => ({
          name: state.name,
          type: state.type,
          color: state.color,
          position: state.position,
          description: state.description,
        })),
      };
    }, 'listStates');
  }

  public async listLabels(params: any) {
    const { teamId } = params;

    if (!teamId) {
      throw new ApiError(400, 'Team ID or key is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const resolvedTeamId = await this.resolver.resolveTeamId(teamId);
      
      const query = `
        query TeamLabels($teamId: String!) {
          team(id: $teamId) {
            key
            name
            labels {
              nodes {
                name
                color
                description
                createdAt
                updatedAt
              }
            }
          }
        }
      `;

      const response = await (this.client as any).client.rawRequest(query, { teamId: resolvedTeamId });
      const team = response.data.team;
      
      if (!team) {
        throw new ApiError(404, 'Team not found', JsonRpcErrorCodes.SERVER_ERROR);
      }

      return {
        team: {
          key: team.key,
          name: team.name,
        },
        labels: team.labels.nodes.map((label: any) => ({
          name: label.name,
          color: label.color,
          description: label.description,
          createdAt: label.createdAt,
          updatedAt: label.updatedAt,
        })),
      };
    }, 'listLabels');
  }

  public async listUsers(params: any) {
    const { limit = 50 } = params;

    return this.executeWithRetry(async () => {
      const users = await this.client.users({
        first: limit,
      });

      return {
        nodes: users.nodes.map((user) => ({
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          createdAt: user.createdAt,
          active: user.active,
        })),
        pageInfo: users.pageInfo,
      };
    }, 'listUsers');
  }

  public async getUser(params: any) {
    const { id } = params;

    if (!id) {
      throw new ApiError(400, 'User ID is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      const resolvedUserId = await this.resolver.resolveUserId(id);
      const user = await this.client.user(resolvedUserId);
      if (!user) {
        throw new ApiError(404, 'User not found', JsonRpcErrorCodes.SERVER_ERROR);
      }

      return {
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
        active: user.active,
      };
    }, 'getUser');
  }

  public async getCurrentUser(_params: any) {
    return this.executeWithRetry(async () => {
      const viewer = await this.client.viewer;

      return {
        name: viewer.name,
        email: viewer.email,
        avatarUrl: viewer.avatarUrl,
        createdAt: viewer.createdAt,
        active: viewer.active,
      };
    }, 'getCurrentUser');
  }

  public async getCapabilities(_params: any) {
    return {
      version: '1.0.0',
      methods: Array.from(this.methodHandlers.keys()),
      notifications: ['linear.webhook'],
      features: {
        rateLimit: {
          requestsPerHour: 1500,
          strategy: 'exponential-backoff',
        },
        payloadChunking: {
          maxTitleLength: 255,
          maxDescriptionLength: 65000,
          strategy: 'smart-split',
          features: [
            'Automatic splitting into multiple comments for large content',
            'Intelligent paragraph and sentence boundary detection',
            'Clear part indicators for multi-part content',
            'No content truncation - all data preserved',
            'Rate limit aware with delays between chunks'
          ],
        },
        webhook: {
          supported: true,
          events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created', 'project.created', 'project.updated'],
        },
        sse: {
          supported: true,
          heartbeatInterval: process.env.SSE_HEARTBEAT_INTERVAL_MS || '15000',
        },
      },
    };
  }

  private smartChunkText(text: string, maxLength: number): string[] {
    // Reserve space for headers/footers (approximately 100 chars)
    const effectiveMaxLength = maxLength - 100;

    if (text.length <= effectiveMaxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let currentChunk = '';

    // Try to split on paragraph boundaries first
    const paragraphs = text.split(/\n\n+/);

    for (const paragraph of paragraphs) {
      // If a single paragraph is too long, we need to split it further
      if (paragraph.length > effectiveMaxLength) {
        // First, flush current chunk if it has content
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // Split long paragraph by sentences
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];

        for (const sentence of sentences) {
          if (sentence.length > effectiveMaxLength) {
            // If even a sentence is too long, split by words
            const words = sentence.split(/\s+/);
            let wordChunk = '';

            for (const word of words) {
              if ((wordChunk + ' ' + word).length > effectiveMaxLength) {
                if (wordChunk) {
                  chunks.push(wordChunk.trim());
                  wordChunk = word;
                } else {
                  // Single word is too long, force split it
                  chunks.push(word.substring(0, effectiveMaxLength));
                  wordChunk = word.substring(effectiveMaxLength);
                }
              } else {
                wordChunk = wordChunk ? wordChunk + ' ' + word : word;
              }
            }

            if (wordChunk) {
              currentChunk = wordChunk;
            }
          } else if ((currentChunk + ' ' + sentence).length > effectiveMaxLength) {
            chunks.push(currentChunk.trim());
            currentChunk = sentence;
          } else {
            currentChunk = currentChunk ? currentChunk + ' ' + sentence : sentence;
          }
        }
      } else if ((currentChunk + '\n\n' + paragraph).length > effectiveMaxLength) {
        // Paragraph fits but would overflow current chunk
        chunks.push(currentChunk.trim());
        currentChunk = paragraph;
      } else {
        // Add paragraph to current chunk
        currentChunk = currentChunk ? currentChunk + '\n\n' + paragraph : paragraph;
      }
    }

    // Don't forget the last chunk
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  public async getFileHistory(params: any) {
    const { file_path, limit = 20 } = params;

    if (!file_path) {
      throw new ApiError(400, 'file_path is required', JsonRpcErrorCodes.INVALID_PARAMS);
    }

    return this.executeWithRetry(async () => {
      try {
        // Check if we're in a git repository
        const isRepo = await GitUtils.isGitRepo();
        if (!isRepo) {
          return {
            filePath: file_path,
            issues: [],
            formatted: `Error: Not in a git repository. Current directory: ${process.cwd()}`,
          };
        }

        // Get commits that modified the file
        const commits = await GitUtils.getFileHistory(file_path, limit * 2);
        
        logger.info({ filePath: file_path, commitCount: commits.length }, 'Got file history');
      
      if (commits.length === 0) {
        return {
          filePath: file_path,
          issues: [],
          message: `No commits found for file: ${file_path}`,
          formatted: `## Issues that modified ${file_path}\n\n*No commits found*\n\n### Debug Info\n- File path: ${file_path}\n- Working directory: ${process.cwd()}\n- Is git repo: ${isRepo}`,
        };
      }

      // Extract issue references from commits and PRs
      const issueMap = new Map<string, {
        identifier: string;
        commitCount: number;
        lastCommitDate: Date;
        commitMessages: string[];
        prs: string[];
      }>();

      for (const commit of commits) {
        // Extract issue references from commit message and body
        const references = IssueParser.extractFromMultipleSources({
          commitMessage: commit.message,
          commitBody: commit.body,
        });
        
        logger.debug({ 
          sha: commit.sha.substring(0, 7), 
          message: commit.message,
          body: commit.body?.substring(0, 100),
          references: references.map(r => r.identifier) 
        }, 'Processing commit');

        // Try to get associated PR
        const prNumber = await GitUtils.getPRForCommit(commit.sha);
        let prReferences: any[] = [];
        
        if (prNumber) {
          const prDetails = await GitUtils.getPRDetails(prNumber);
          if (prDetails) {
            prReferences = IssueParser.extractFromMultipleSources({
              prTitle: prDetails.title,
              prBody: prDetails.body,
            });
            logger.debug({ 
              prNumber, 
              prTitle: prDetails.title,
              prReferences: prReferences.map(r => r.identifier) 
            }, 'Found PR');
          }
        }

        // Combine references from commit and PR
        const allReferences = [...references, ...prReferences];
        const uniqueRefs = new Map<string, any>();
        allReferences.forEach(ref => uniqueRefs.set(ref.identifier, ref));

        // Update issue map
        for (const ref of uniqueRefs.values()) {
          const existing = issueMap.get(ref.identifier);
          if (existing) {
            existing.commitCount++;
            existing.lastCommitDate = commit.date > existing.lastCommitDate ? commit.date : existing.lastCommitDate;
            if (!existing.commitMessages.includes(commit.message)) {
              existing.commitMessages.push(commit.message);
            }
            if (prNumber && !existing.prs.includes(prNumber)) {
              existing.prs.push(prNumber);
            }
          } else {
            issueMap.set(ref.identifier, {
              identifier: ref.identifier,
              commitCount: 1,
              lastCommitDate: commit.date,
              commitMessages: [commit.message],
              prs: prNumber ? [prNumber] : [],
            });
          }
        }
      }

      // Convert to array and sort by last commit date
      const issuesList = Array.from(issueMap.values()).sort(
        (a, b) => b.lastCommitDate.getTime() - a.lastCommitDate.getTime()
      );

      // Limit the results
      const limitedIssues = issuesList.slice(0, limit);

      // Batch resolve issue details from Linear
      const issueDetails = await Promise.all(
        limitedIssues.map(async (issue) => {
          try {
            // Try to resolve the issue ID and get basic details
            const issueId = await this.resolver.resolveIssueId(issue.identifier);
            
            // Use raw GraphQL to get issue details without membership field
            const query = `
              query GetIssueBasics($id: String!) {
                issue(id: $id) {
                  id
                  identifier
                  title
                  state {
                    name
                    type
                  }
                  createdAt
                  updatedAt
                }
              }
            `;
            
            const response = await (this.client as any).client.rawRequest(query, { id: issueId });
            const linearIssue = response.data.issue;
            
            if (linearIssue) {
              return {
                ...issue,
                title: linearIssue.title,
                status: linearIssue.state?.name || 'Unknown',
                stateType: linearIssue.state?.type,
                exists: true,
              };
            }
          } catch (error) {
            logger.warn({ error, identifier: issue.identifier }, 'Failed to resolve issue');
          }
          
          return {
            ...issue,
            title: 'Issue not found or inaccessible',
            status: 'Unknown',
            exists: false,
          };
        })
      );


      // Format the output - simple list of issues
      let output = '';
      
      if (issueDetails.length === 0) {
        output = `No Linear issues found in ${commits.length} commits for ${file_path}`;
        
        // Add debug info if no issues found
        if (commits.length > 0 && issueMap.size === 0) {
          output += '\n\nDebug: Found commits but no Linear issue references.';
          const sampleCommit = commits[0];
          output += `\nFirst commit: "${sampleCommit.message}"`;
        }
      } else {
        // Simple chronological list of issues
        const issueList = issueDetails.map(issue => issue.identifier);
        output = `Issues that modified ${file_path}: [${issueList.join(', ')}]`;
        
        // Add issue titles on separate lines
        output += '\n\n';
        for (const issue of issueDetails) {
          output += `${issue.identifier}: ${issue.title}\n`;
        }
      }

      return {
        filePath: file_path,
        issues: issueDetails,
        totalCommits: commits.length,
        formatted: output,
      };
      } catch (error) {
        logger.error({ error, filePath: file_path }, 'Error in getFileHistory');
        return {
          filePath: file_path,
          issues: [],
          formatted: `Error processing file history: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }, 'getFileHistory');
  }
}
/** Download Platform-managed chat attachments into the Agent workspace. */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import path from 'node:path';
import { safeAttachmentName } from '../attachments';
import { agentAttachmentWorkDir } from '../paths';
import type { PlatformClient } from '../platform-client';
import {
  resolveAgentWorkspacePath,
  writeResolvedAgentWorkspaceFile,
} from '../workspace-paths';
import { requireSessionId, text, tool } from './shared';

export function createAttachmentTool(options: {
  sessionId?: string;
  platform: PlatformClient;
}): AgentTool {
  return tool({
    name: 'download_attachment',
    label: 'Download attachment',
    description:
      'Download a user-provided chat attachment into this Agent workdir. ' +
      'Use the attachment id listed in the user message. Returns the saved path.',
    executionMode: 'sequential',
    parameters: Type.Object({
      attachment_id: Type.String({ description: 'Attachment id from chat.' }),
      path: Type.Optional(
        Type.String({
          description:
            'Destination inside this Agent workdir. Defaults to ' +
            'attachments/<id>/<original-name>.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      const downloaded = await options.platform.downloadAttachment(
        sessionId,
        params.attachment_id,
        signal,
      );
      const name = safeAttachmentName(downloaded.name);
      const defaultPath = path.join(
        agentAttachmentWorkDir(sessionId, downloaded.id),
        name,
      );
      const destination = await resolveAgentWorkspacePath(
        sessionId,
        params.path ?? defaultPath,
      );
      await writeResolvedAgentWorkspaceFile(
        destination,
        downloaded.body,
        signal,
      );
      return text(
        `Downloaded ${name} to ${destination.path} ` +
          `(${downloaded.size} bytes, ${downloaded.mimeType}).`,
        {
          attachmentId: downloaded.id,
          path: destination.path,
          absolutePath: destination.absolutePath,
          name,
          mimeType: downloaded.mimeType,
          size: downloaded.size,
        },
      );
    },
  });
}

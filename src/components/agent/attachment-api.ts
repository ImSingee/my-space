import type { AgentAttachmentRef } from '~agent/attachments';
import type { ComposerFile } from './composer';

export async function uploadAgentFiles(
  sessionId: string,
  files: ComposerFile[],
): Promise<AgentAttachmentRef[]> {
  return Promise.all(
    files.map(async (attachment) => {
      const res = await fetch(
        `/api/agent/sessions/${encodeURIComponent(sessionId)}/attachments/` +
          encodeURIComponent(attachment.id),
        {
          method: 'PUT',
          headers: {
            'content-type': attachment.mimeType,
            'x-attachment-name': encodeURIComponent(attachment.name),
          },
          body: attachment.file,
        },
      );
      if (!res.ok) {
        throw new Error(
          (await res.text()) || `Attachment upload failed (${res.status})`,
        );
      }
      const payload = (await res.json()) as {
        attachment: AgentAttachmentRef;
      };
      return payload.attachment;
    }),
  );
}

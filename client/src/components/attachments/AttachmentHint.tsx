import React from 'react';
import { Paperclip } from 'lucide-react';

interface AttachmentHintProps {
  text: string;
}

const AttachmentHint: React.FC<AttachmentHintProps> = ({ text }) => (
  <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
    <Paperclip className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <span>{text}</span>
  </div>
);

export default AttachmentHint;

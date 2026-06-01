import { attachmentMeta } from '../../utils/attachments';
import AudioBlock from './AudioBlock';
import FileBox from './FileBox';
import ImageBlock from './ImageBlock';
import PdfBlock from './PdfBlock';
import VideoBlock from './VideoBlock';

// Dispatches an attachment URL to the right inline "view" by category. Each
// media block degrades to a tap-to-open box when its native module is absent.
export default function AttachmentView({ url, label }) {
  const { category } = attachmentMeta(url);
  switch (category) {
    case 'image':
      return <ImageBlock uri={url} alt={label} />;
    case 'video':
      return <VideoBlock url={url} label={label} />;
    case 'audio':
      return <AudioBlock url={url} label={label} />;
    case 'pdf':
      return <PdfBlock url={url} label={label} />;
    default:
      return <FileBox url={url} label={label} />;
  }
}

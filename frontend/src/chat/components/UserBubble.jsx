import { noteLabel } from "../engine/messageModel";
import ContextTag from "./ContextTag";

// A user message: locked-note context tags (dock only — omitted when absent),
// any attached images, then the text.
export default function UserBubble({ content, context, images }) {
	return (
		<div className="chat-user-row">
			<div className="chat-user-card">
				{context?.length ? (
					<div className="chat-context-tags chat-context-tags--bubble">
						{context.map((path) => (
							<ContextTag
								key={path}
								label={noteLabel(path)}
								title={path}
								locked
							/>
						))}
					</div>
				) : null}
				{images?.length ? (
					<div className="chat-user-images">
						{images.map((img) => (
							<a
								key={img.url}
								href={img.url}
								target="_blank"
								rel="noreferrer"
								className="chat-user-image"
							>
								<img src={img.url} alt="attachment" />
							</a>
						))}
					</div>
				) : null}
				{content ? <div className="chat-user-text">{content}</div> : null}
			</div>
		</div>
	);
}

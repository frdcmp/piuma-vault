import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { theme } from "antd";
import { useEffect, useState } from "react";

export default function BlockNoteEditorComp({
	initialMarkdown,
	onChange,
	currentTheme,
	isMobile,
}) {
	const [editor, setEditor] = useState(null);
	const { token } = theme.useToken();

	useEffect(() => {
		let isMounted = true;
		async function load() {
			try {
				const temp = BlockNoteEditor.create();
				const blocks = await temp.tryParseMarkdownToBlocks(
					initialMarkdown || "",
				);
				if (!isMounted) return;
				const e = BlockNoteEditor.create({ initialContent: blocks });
				setEditor(e);
			} catch (err) {
				console.error("Error parsing markdown for BlockNote:", err);
				if (isMounted) {
					setEditor(BlockNoteEditor.create());
				}
			}
		}
		load();
		return () => {
			isMounted = false;
		};
	}, [initialMarkdown]);

	if (!editor) {
		return (
			<div style={{ padding: 24, color: token.colorTextSecondary }}>
				Loading editor...
			</div>
		);
	}

	return (
		<div className="pv-bn-wrapper" style={{ paddingBottom: 0 }}>
			<BlockNoteView
				editor={editor}
				theme={currentTheme === "dark" ? "dark" : "light"}
				onChange={async () => {
					const md = await editor.blocksToMarkdownLossy(editor.document);
					onChange(md);
				}}
			/>
		</div>
	);
}

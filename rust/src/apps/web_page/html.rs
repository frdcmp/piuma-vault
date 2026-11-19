//! Text out of HTML: what a person would read, a line per block.

use ego_tree::iter::Edge;
use scraper::{ElementRef, Html, Node, Selector};

const UNREAD: &[&str] = &["script", "style", "noscript", "template", "svg", "head", "iframe"];
const BLOCKS: &[&str] = &[
    "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "figure", "figcaption", "form", "dl", "dt", "dd", "hr", "address", "details", "summary",
];

fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("a valid selector")
}

pub fn title(doc: &Html) -> Option<String> {
    first(doc, "title")
}

/// The first element matching `css`, as one line of text; none when there's no such element or it's empty.
pub fn first(doc: &Html, css: &str) -> Option<String> {
    let el = doc.select(&selector(css)).next()?;
    Some(one_line(&el.text().collect::<String>())).filter(|s| !s.is_empty())
}

pub fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A page's text: its `<main>` when it has one, or else its whole body.
pub fn page_text(doc: &Html) -> String {
    let within = doc.select(&selector("main")).next().or_else(|| doc.select(&selector("body")).next()).unwrap_or_else(|| doc.root_element());
    text(within)
}

/// The text of a piece of HTML that isn't a whole page (a description stored as HTML).
pub fn fragment_text(html: &str) -> String {
    text(Html::parse_fragment(html).root_element())
}

/// An element's text: a line per block, list items as `- `, nothing of scripts and styles.
pub fn text(el: ElementRef) -> String {
    let mut raw = String::new();
    let mut unread = 0usize; // how deep inside an element that isn't read
    let mut pre = 0usize; // how deep inside a <pre>, where a line break in the text is one
    for edge in el.traverse() {
        match edge {
            Edge::Open(node) => match node.value() {
                Node::Text(t) if unread == 0 && pre > 0 => raw.push_str(t),
                Node::Text(t) if unread == 0 => raw.extend(t.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c })),
                Node::Element(e) if unread > 0 || UNREAD.contains(&e.name()) => unread += 1,
                Node::Element(e) => match e.name() {
                    "br" => raw.push('\n'),
                    "li" => raw.push_str("\n- "),
                    "pre" => {
                        pre += 1;
                        raw.push('\n');
                    }
                    name if BLOCKS.contains(&name) => raw.push('\n'),
                    _ => {}
                },
                _ => {}
            },
            Edge::Close(node) => {
                if let Node::Element(e) = node.value() {
                    if unread > 0 {
                        unread -= 1;
                    } else if e.name() == "pre" {
                        pre -= 1;
                        raw.push('\n');
                    } else if e.name() == "li" || BLOCKS.contains(&e.name()) {
                        raw.push('\n');
                    } else if matches!(e.name(), "td" | "th") {
                        raw.push(' ');
                    }
                }
            }
        }
    }
    let mut out = String::new();
    let mut bullet = false; // a list item whose text starts on a later line
    for line in raw.lines().map(one_line) {
        if line.is_empty() {
            continue;
        }
        if line == "-" {
            bullet = true;
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        if std::mem::take(&mut bullet) {
            out.push_str("- ");
        }
        out.push_str(&line);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_a_line_per_block() {
        let html = "<div><h2>Title</h2><p>One <b>bold</b>\n   word</p><script>var a = 1;</script><ul><li>first</li><li><p>second</p></li></ul>after<br>the list<table><tr><td>a</td><td>b</td></tr></table><pre>x = 1\ny = 2</pre></div>";
        assert_eq!(fragment_text(html), "Title\nOne bold word\n- first\n- second\nafter\nthe list\na b\nx = 1\ny = 2");
    }

    #[test]
    fn text_decodes_entities_and_keeps_any_alphabet() {
        assert_eq!(fragment_text("<p>ราคา ฿35,000 &ndash; ฿50,000 &amp; more</p>"), "ราคา ฿35,000 – ฿50,000 & more");
    }

    #[test]
    fn first_is_one_line_or_nothing() {
        let doc = Html::parse_document("<html><body><h1 class=\"t\">\n  A   title\n</h1><span class=\"e\">  </span></body></html>");
        assert_eq!(first(&doc, ".t").as_deref(), Some("A title"));
        assert_eq!(first(&doc, ".e"), None);
        assert_eq!(first(&doc, ".missing"), None);
    }
}

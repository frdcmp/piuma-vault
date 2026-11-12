//! Pigeon's tools: what Piuma (the vault agent) does with the Inbox on the user's word, through the
//! vault's agent tools (`apps::agents::tools::pigeon`). Every one runs as the user, on their own
//! conversations, people and rules only.
//!
//! Two rules hold whatever the model asks:
//!   - a message to someone goes only on the user's word, in words they've seen: `pigeon_draft_reply`
//!     and `pigeon_draft_email` leave a ✍ card in the Inbox (the user's Send there sends it, or
//!     their yes in the chat: `pigeon_approve`; `pigeon_edit_draft` changes its words, still
//!     waiting); `pigeon_send_reply` sends words the user saw and told Piuma to send, at once
//!   - a big change (auto switched on, a merge, a rule deleted or set to trash, a rule run on past
//!     messages, someone let to hear something from Pigeon on its own) becomes a 🕊 confirmation
//!     card (`confirm`): it runs when the user taps Yes

use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::connectors::Kind;
use crate::apps::pigeon::conversations::{self, Conversation};
use crate::apps::pigeon::policy::Policy;
use crate::apps::pigeon::state::{AppState, State};
use crate::apps::pigeon::access::{self, Holder, What};
use crate::apps::pigeon::{actions, agent, alerts, away, cards, confirm, facts, media, people, policy, rules, tell};

/// Who Piuma's decisions are logged as.
const BY: &str = "piuma";

fn id(d: &str) -> Json {
    json!({ "type": "string", "description": d })
}

/// (name, description, JSON schema): the agent tools' shape.
pub fn defs() -> Vec<(&'static str, &'static str, Json)> {
    vec![
        (
            "pigeon_inbox",
            "The Inbox (Pigeon: the user's WhatsApp, Instagram and Gmail in one place): conversations whose latest messages need a reply (reply), hold something to do (action) or are worth knowing (fyi), most important first, with who, when, a preview and how many cards wait there. Handled ones are left out unless include_handled.",
            json!({ "type": "object", "properties": {
                "attention": { "type": "string", "enum": ["reply", "action", "fyi"], "description": "Only this kind" },
                "connector": { "type": "string", "description": "Only this channel (gmail, whatsapp, instagram)" },
                "include_handled": { "type": "boolean" },
                "limit": { "type": "integer", "description": "Default 30" },
            }}),
        ),
        (
            "pigeon_search",
            "Search every message in the Inbox (words, a name, an address), newest first, with its conversation and its files (as pigeon_conversation lists them).",
            json!({ "type": "object", "properties": {
                "query": { "type": "string" },
                "connector": { "type": "string" },
                "limit": { "type": "integer", "description": "Default 20" },
            }, "required": ["query"] }),
        ),
        (
            "pigeon_conversation",
            "One Inbox conversation: its recent messages, a summary, the person (the user's note, what Pigeon knows, how the user writes to them), its policies and what waits there. A message's photos, videos, voice notes and documents are its `files`: what each is, a voice note's words, and its id (the file itself is fetched by the message's id and the file's).",
            json!({ "type": "object", "properties": {
                "conversation_id": id("From pigeon_inbox or pigeon_search"),
                "items": { "type": "integer", "description": "How many recent messages, default 20" },
            }, "required": ["conversation_id"] }),
        ),
        (
            "pigeon_mark_handled",
            "Take a conversation off the Inbox's list of what needs the user (they dealt with it). New messages bring it back.",
            json!({ "type": "object", "properties": { "conversation_id": id("The conversation") }, "required": ["conversation_id"] }),
        ),
        (
            "pigeon_pending",
            "What waits for the user in the Inbox: drafts and suggestions (replies, tasks, events), rule runs (kind rule_run), Pigeon's questions (kind question: answer with pigeon_answer), 🔑 cards (kind uncovered: someone asked for what they hold no permission for; pigeon_answer with once, granted or no) and confirmations (kind confirmation: only the user's tap in the Inbox decides them).",
            json!({ "type": "object", "properties": { "limit": { "type": "integer", "description": "Default 50" } } }),
        ),
        (
            "pigeon_draft_reply",
            "A reply to an Inbox conversation, as a DRAFT the user sends from the Inbox (never sent from here). With `text`: those exact words. With `instructions` (or nothing): Pigeon writes it in the user's voice for that person. Show the user the draft's text.",
            json!({ "type": "object", "properties": {
                "conversation_id": id("The conversation"),
                "text": { "type": "string", "description": "The reply's exact words, when the user gave them" },
                "instructions": { "type": "string", "description": "What the reply should say, for Pigeon to write" },
            }, "required": ["conversation_id"] }),
        ),
        (
            "pigeon_send_reply",
            "Send a message in an Inbox conversation NOW, as the user, with these exact words. Only when the user told you to send it and has seen these exact words in this chat: show them the text and wait for their yes (words they dictated with \"send it\" count as seen). When they haven't said send: pigeon_draft_reply. Sent and logged like their own Send in the Inbox.",
            json!({ "type": "object", "properties": {
                "conversation_id": id("The conversation"),
                "text": { "type": "string", "description": "The message's exact words, as the user saw them" },
            }, "required": ["conversation_id", "text"] }),
        ),
        (
            "pigeon_draft_email",
            "A new email (its own thread) to one address, from the user's connected Gmail, as a DRAFT the user sends from the Inbox (never sent from here). Show the user its text.",
            json!({ "type": "object", "properties": {
                "to": { "type": "string", "description": "One email address" },
                "subject": { "type": "string" },
                "text": { "type": "string", "description": "The email's text, plain" },
                "from": { "type": "string", "description": "Which connected Gmail account, when there's more than one" },
            }, "required": ["to", "subject", "text"] }),
        ),
        (
            "pigeon_edit_draft",
            "Change a waiting draft's words (from pigeon_pending): it stays a draft for the user to send.",
            json!({ "type": "object", "properties": {
                "action_id": id("The draft, from pigeon_pending"),
                "text": { "type": "string", "description": "The new words" },
            }, "required": ["action_id", "text"] }),
        ),
        (
            "pigeon_approve",
            "Do a waiting suggestion (a task, an event, an archive) or a waiting rule run, on the user's yes. A draft (a message to someone) is sent: only when the user told you to send it and has seen its words (show them first). `edits` replaces some of the arguments first (e.g. {\"text\": …} for the words they changed).",
            json!({ "type": "object", "properties": {
                "action_id": id("From pigeon_pending"),
                "edits": { "type": "object", "description": "Arguments to replace before doing it" },
            }, "required": ["action_id"] }),
        ),
        (
            "pigeon_drop",
            "Drop something waiting in the Inbox (a draft, a suggestion, a rule run, or a question of Pigeon's) without doing or answering it.",
            json!({ "type": "object", "properties": { "action_id": id("From pigeon_pending"), "why": { "type": "string" } }, "required": ["action_id"] }),
        ),
        (
            "pigeon_answer",
            "Answer a question Pigeon asked the user (from pigeon_pending, kind question), in the user's words: Pigeon goes back to that conversation and acts on it (its reply waits as a draft unless the user set replies to auto). A 🔑 card (kind uncovered) takes `once` (Pigeon drafts the answer, this time only), `granted` (after pigeon_grant: it drafts with the permission) or `no`.",
            json!({ "type": "object", "properties": {
                "question_id": id("From pigeon_pending"),
                "answer": { "type": "string", "description": "The user's answer, in their words" },
            }, "required": ["question_id", "answer"] }),
        ),
        (
            "pigeon_rules",
            "The user's Inbox rules for what a sender keeps sending (bank alerts, receipts, notification mail): what each matches, what Jev checks it is, its steps, its mode (ask, auto, paused) and its runs of the last 30 days.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "pigeon_set_rule",
            "Make an Inbox rule, or change one (with rule_id; arguments left out keep their value). It matches new incoming messages by connector (or * for any channel), sender (an address, @domain for anyone there, a number) and/or person (contact_id), words in the subject, and who else it went to (recipients); Jev checks each is what `expects` says. Then: `record_tool` (vault_log for a line in a running note, e.g. a monthly ledger; vault_create_task; vault_create_event) filled in from the message following `record_instructions` (say the note's folder, title and line format), then `then_action` on the message (none, mark_read, archive, trash). A new rule is on ask (each run waits for the user) unless they say auto. A rule set to auto or to trash needs the user's tap in the Inbox. Try it with pigeon_try_rule.",
            json!({ "type": "object", "properties": {
                "rule_id": { "type": "integer", "description": "To change this rule" },
                "name": { "type": "string", "description": "Short: \"Bank transfers\"" },
                "connector": { "type": "string", "description": "gmail (the default), whatsapp, instagram, or * for any channel" },
                "sender": { "type": "string", "description": "A handle: alerts@bank.example, @shop.example for anyone there, a phone number. Optional with contact_id" },
                "contact_id": { "type": "string", "description": "A person (from pigeon_contacts): their messages on any of their handles" },
                "recipients": { "type": "object", "description": "Who else the message went to (email), each optional; {} clears: you_are to | cc | any; with: [addresses or @domains]; alone: true | false", "properties": {
                    "you_are": { "type": "string", "enum": ["to", "cc", "any"] },
                    "with": { "type": "array", "items": { "type": "string" } },
                    "alone": { "type": "boolean" },
                } },
                "subject_has": { "type": "string", "description": "Words the subject must contain (optional)" },
                "expects": { "type": "string", "description": "What the matching messages are, for Jev: \"a notice of a successful transfer or payment\"" },
                "record_tool": { "type": "string", "description": "vault_log, vault_create_task or vault_create_event; empty for none" },
                "record_instructions": { "type": "string", "description": "How to fill it in: \"note Bank YYYY-MM in /finance/bank; one line: - YYYY-MM-DD HH:MM · amount · to whom\"" },
                "then_action": { "type": "string", "enum": ["none", "mark_read", "archive", "trash"] },
                "mode": { "type": "string", "enum": ["ask", "auto", "paused"] },
            } }),
        ),
        (
            "pigeon_delete_rule",
            "Delete an Inbox rule (its runs go with it; what it already did stays done). Needs the user's tap in the Inbox.",
            json!({ "type": "object", "properties": { "rule_id": { "type": "integer" } }, "required": ["rule_id"] }),
        ),
        (
            "pigeon_try_rule",
            "Try an Inbox rule on messages Pigeon already has (newest first): Jev's check and the steps it would run, changing nothing. With apply=true it runs on them as if they had just come in (needs the user's tap in the Inbox).",
            json!({ "type": "object", "properties": {
                "rule_id": { "type": "integer" },
                "limit": { "type": "integer", "description": "Messages, default 3" },
                "apply": { "type": "boolean" },
            }, "required": ["rule_id"] }),
        ),
        (
            "pigeon_rule_runs",
            "What the Inbox rules did, newest first: each run's message, Jev's match, the steps and what came of them.",
            json!({ "type": "object", "properties": {
                "rule_id": { "type": "integer" },
                "status": { "type": "string", "enum": ["pending", "done", "failed", "skipped", "dropped", "expired"] },
                "limit": { "type": "integer", "description": "Default 20" },
            } }),
        ),
        (
            "pigeon_actions",
            "The Inbox's action log: everything Pigeon proposed or did (replies, tasks, archives), newest first.",
            json!({ "type": "object", "properties": {
                "status": { "type": "string", "enum": ["pending", "done", "dropped", "expired", "failed"] },
                "conversation_id": id("Only this conversation's"),
                "limit": { "type": "integer", "description": "Default 30" },
            }}),
        ),
        (
            "pigeon_contacts",
            "People in the Inbox, with their @slug, their handles (addresses, phone numbers, Instagram ids or @usernames), who they are to the user, the language to write to them in, their vault note (note_id), the user's note on them, what Pigeon knows about them and how the user writes to them on each channel.",
            json!({ "type": "object", "properties": { "query": { "type": "string", "description": "A name, @slug, handle or relationship" }, "limit": { "type": "integer" } } }),
        ),
        (
            "pigeon_set_contact",
            "Create an Inbox contact (no contact_id; a name needed) or change one. A field given is set (\"\" clears it), one left out stays. relationship: who they are to the user (mother, friend, colleague, client, self for the user's own other accounts, service for senders that aren't people…); language: the one to write to them in; note_id: their vault note (a contact note); slug: their @slug (lowercase, unique). add_handles / remove_handles: [{channel: gmail|instagram|whatsapp, handle}]: an email address; on WhatsApp the phone number with its country code; on Instagram the @username or the account's id. A handle that is another contact's is refused: the same person twice is pigeon_merge_contacts.",
            json!({ "type": "object", "properties": {
                "contact_id": id("The contact to change; none for a new one"),
                "name": { "type": "string" },
                "relationship": { "type": "string" },
                "language": { "type": "string" },
                "note_id": { "type": "string" },
                "slug": { "type": "string", "description": "With or without the @" },
                "add_handles": { "type": "array", "items": { "type": "object", "properties": { "channel": { "type": "string" }, "handle": { "type": "string" } }, "required": ["channel", "handle"] } },
                "remove_handles": { "type": "array", "items": { "type": "object", "properties": { "channel": { "type": "string" }, "handle": { "type": "string" } }, "required": ["channel", "handle"] } },
            } }),
        ),
        (
            "pigeon_set_note",
            "The user's own note on a person (who they are, how to write to them, what never to agree to). Pigeon's replies follow it above everything. Empty clears it.",
            json!({ "type": "object", "properties": { "contact_id": id("From pigeon_contacts or pigeon_conversation"), "note": { "type": "string" } }, "required": ["contact_id", "note"] }),
        ),
        (
            "pigeon_merge_contacts",
            "Two Inbox contacts that are one person: merge_id folds into contact_id, which takes its handles, conversations and rules. Can't be undone: needs the user's tap in the Inbox.",
            json!({ "type": "object", "properties": {
                "contact_id": id("The contact to keep"),
                "merge_id": id("The contact folded into it, then gone"),
            }, "required": ["contact_id", "merge_id"] }),
        ),
        (
            "pigeon_names_from_whatsapp",
            "Name the people known only by their number from the user's WhatsApp: the name the user saved them under on the phone, else the one WhatsApp shows, else the one their messages carry; each gets an @slug. With contact_id: just that person. Without: everyone, and the people saved on the phone who aren't in the Inbox yet are added.",
            json!({ "type": "object", "properties": { "contact_id": id("Only this person (from pigeon_contacts)") } }),
        ),
        (
            "pigeon_learn",
            "Learn about people from their past conversations: older conversations come in from the channels as history (never sorted or answered), then each person's memory and, per channel, how the user writes to them are written. With contact_id: that person, now (default the last 365 days). Without: everyone the user wrote to in the last `days` (default 90), in the background.",
            json!({ "type": "object", "properties": {
                "contact_id": id("Only this person (from pigeon_contacts)"),
                "days": { "type": "integer", "description": "How far back to bring conversations in" },
            } }),
        ),
        (
            "pigeon_policies",
            "Every Inbox policy (off, ask, auto per kind of action: reply, record, organize; default, per contact, per conversation) and whether auto is switched on.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "pigeon_set_policy",
            "Set off, ask or auto for a kind of Inbox action (reply, record, organize): the default, or for one contact or conversation (the most specific wins). `inherit` removes a contact's or conversation's own. Only set auto when the user asks for it; auto needs their tap in the Inbox.",
            json!({ "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["reply", "record", "organize"] },
                "policy": { "type": "string", "enum": ["off", "ask", "auto", "inherit"] },
                "contact_id": id("For this person"),
                "conversation_id": id("For this conversation"),
            }, "required": ["kind", "policy"] }),
        ),
        (
            "pigeon_set_alerts",
            "How loud someone is on the user's phone: all (every message rings), smart (the default: messages arrive silently, a card rings), quiet (all silent), off (nothing on the phone, all kept in the Inbox). Urgent ones ring whatever it is. For one contact, one conversation (a group), or the default; `inherit` removes a contact's or conversation's own.",
            json!({ "type": "object", "properties": {
                "level": { "type": "string", "enum": ["all", "smart", "quiet", "off", "inherit"] },
                "contact_id": id("For this person"),
                "conversation_id": id("For this conversation"),
            }, "required": ["level"] }),
        ),
        (
            "pigeon_resume_auto",
            "Let auto replies answer again now: after the user writes in a conversation they wait 10 minutes, and send at most 3 an hour; this starts both over. For one conversation, or with contact_id all of a person's.",
            json!({ "type": "object", "properties": {
                "conversation_id": id("This conversation"),
                "contact_id": id("All of this person's conversations"),
            } }),
        ),
        (
            "pigeon_set_auto",
            "The Inbox's one switch: enabled=false stops every auto action at once (they wait for the user instead); true lets the auto policies act again (needs the user's tap in the Inbox).",
            json!({ "type": "object", "properties": { "enabled": { "type": "boolean" } }, "required": ["enabled"] }),
        ),
        (
            "pigeon_away",
            "Away mode, like an away status: while the user is away (asleep, on a plane, in a meeting) Pigeon answers people on WhatsApp \
             and Instagram itself, as Pigeon (each message marked), says the user is away, takes messages and notes what they want for \
             the user; it never agrees to anything for them. Set it when the user says they're going away (reason in a few words, \
             and when they're back if they said: `until` or `minutes`); `end: true` when they're back (Pigeon's chat then says what \
             happened); no arguments: whether they're away.",
            json!({ "type": "object", "properties": {
                "reason": { "type": "string", "description": "Why, in a few words, as people may read it: \"sleeping\", \"on a plane\", \"in a meeting\"" },
                "until": { "type": "string", "description": "When they're back, ISO 8601 with the offset" },
                "minutes": { "type": "integer", "description": "Or: back in this many minutes" },
                "end": { "type": "boolean", "description": "true: they're back" },
            } }),
        ),
        (
            "pigeon_access",
            "Who Pigeon may tell what, all at once: the catalogue (each tool the people who write may be answered with, like the user's place or \
             calendar, and its levels, least first), the user's groups (Family, Friends: who's in, what each holds, which group sits in which), \
             what people and chats hold on their own, and whether sharing is paused. A permission is `tool.level.mode`: mode `ask` = Pigeon \
             prepares the answer and the user taps, `auto` = Pigeon answers and tells them; a level includes the ones under it; `*` is any part.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "pigeon_permissions",
            "What one person, one chat or one group holds: their own grants, the groups they're in, and everything that counts for them with \
             where each comes from (their own, the chat's, from a group, through which groups). A group chat gets only the chat's own, never \
             its members'.",
            json!({ "type": "object", "properties": {
                "contact_id": id("A person (pigeon_contacts)"),
                "conversation_id": id("A chat"),
                "group_id": id("A group"),
                "group": { "type": "string", "description": "Or the group by its name" },
            } }),
        ),
        (
            "pigeon_groups",
            "The user's groups of people (who may be told what goes by group, like roles): every group with how many people and what it \
             holds, or one group (group_id or group) with its people, the groups in it and what it inherits.",
            json!({ "type": "object", "properties": {
                "group_id": id("One group"),
                "group": { "type": "string", "description": "Or by its name" },
            } }),
        ),
        (
            "pigeon_set_group",
            "Make a group (name), rename or describe one (group_id or group, with name and/or description: its people and permissions stay), \
             or delete one (delete: true, needs the user's tap: everyone in it loses what it gave).",
            json!({ "type": "object", "properties": {
                "group_id": id("The group to change; none: a new one"),
                "group": { "type": "string", "description": "Or the group to change by its name today" },
                "name": { "type": "string", "description": "Its name (new, or renamed to)" },
                "description": { "type": "string", "description": "Who it's for, in a few words; \"\" clears it" },
                "delete": { "type": "boolean" },
            } }),
        ),
        (
            "pigeon_grant",
            "Give a person, a chat or a group a permission (`permission`: tool.level.mode from pigeon_access's catalogue, like \
             location.city.ask; it replaces what they held for that tool), or put a person or a group in a group (`member_of`: the group's id \
             or name). `until` or `minutes` makes it end by itself (\"tell Marco where I am for the next two hours\"). Give `said`: the user's \
             own words for it. Only on the user's word, and for exactly whom and what they said. Mode `ask` is safe (the user still taps each \
             answer); anything that lets Pigeon answer on its own (mode auto, or a place in a group that holds an auto) waits for the user's \
             tap in the Inbox.",
            json!({ "type": "object", "properties": {
                "contact_id": id("To this person"),
                "conversation_id": id("Or to this chat (a group chat's only way)"),
                "group_id": id("Or to this group"),
                "group": { "type": "string", "description": "Or to the group with this name" },
                "permission": { "type": "string", "description": "tool.level.mode, e.g. location.city.ask, calendar.busy.auto, location.*.ask" },
                "member_of": { "type": "string", "description": "Or: put them in this group (its id or name)" },
                "until": { "type": "string", "description": "When it ends, ISO 8601 with the offset" },
                "minutes": { "type": "integer", "description": "Or: it ends in this many minutes" },
                "said": { "type": "string", "description": "The user's words for it" },
            } }),
        ),
        (
            "pigeon_revoke",
            "Take back a permission or a place in a group: by grant_id (from pigeon_permissions), or by whom (contact_id, conversation_id, \
             group_id or group) and what (permission or member_of). What they hold through a group stays: take them out of the group, or \
             change the group.",
            json!({ "type": "object", "properties": {
                "grant_id": id("The grant"),
                "contact_id": id("Or whose: this person's"),
                "conversation_id": id("this chat's"),
                "group_id": id("this group's"),
                "group": { "type": "string", "description": "the group's with this name" },
                "permission": { "type": "string", "description": "and what: this permission" },
                "member_of": { "type": "string", "description": "or their place in this group (its id or name)" },
            } }),
        ),
        (
            "pigeon_pause_sharing",
            "\"Don't tell anyone anything\": while it's on Pigeon answers nobody with the user's place, calendar or anything else they were \
             granted, whatever they hold. On with `minutes` or `until` (none: until the user ends it), `end: true` ends it, no arguments: \
             whether it's on.",
            json!({ "type": "object", "properties": {
                "pause": { "type": "boolean", "description": "true: pause now" },
                "until": { "type": "string", "description": "Until when, ISO 8601 with the offset" },
                "minutes": { "type": "integer", "description": "Or: for this many minutes" },
                "end": { "type": "boolean", "description": "true: sharing again" },
            } }),
        ),
        (
            "pigeon_tool_uses",
            "What Pigeon told people with the user's leave: the replies (sent, or waiting as drafts) that used a tool, newest first, each \
             with what was told, at which level, through which permission and from where, and how sure Jev was they asked. For one person \
             (contact_id), one chat (conversation_id), or everyone.",
            json!({ "type": "object", "properties": {
                "contact_id": id("Only to this person"),
                "conversation_id": id("Only in this chat"),
                "limit": { "type": "integer", "description": "At most this many (default 30)" },
            } }),
        ),
        (
            "pigeon_facts",
            "What Pigeon knows about the user right now: `facts` (their place, written by the phone, or anything said about themselves: told \
             to whoever holds the tool's permission, at their level) and `passons` (what the user left for one person or one chat to hear \
             when they ask).",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "pigeon_set_fact",
            "Write what Pigeon knows about the user for a key (the latest replaces the one before): `location` is their place, said at each \
             level it's known at (`levels`: {\"country\": \"Japan\", \"city\": \"Tokyo\", \"area\": \"Shibuya, Tokyo\", \"exact\": \"…\"}: \
             people are told it only up to the level they hold, so leave out what the user didn't say). `until` or `minutes` makes it end by \
             itself. Or forget one: `fact_id` with `delete: true` (a fact or a pass-on, from pigeon_facts). Only on the user's word.",
            json!({ "type": "object", "properties": {
                "key": { "type": "string", "description": "The tool it's for (pigeon_access's catalogue): location" },
                "levels": { "type": "object", "description": "It, said at each level: the tool's level names to words" },
                "value": { "type": "object", "description": "Anything more to keep with it (a place's lat, lon)" },
                "until": { "type": "string", "description": "When it stops being true, ISO 8601 with the offset" },
                "minutes": { "type": "integer", "description": "Or: true for this many minutes" },
                "fact_id": id("With delete: the fact or pass-on to forget"),
                "delete": { "type": "boolean" },
            } }),
        ),
        (
            "pigeon_passon",
            "Leave something for one person (contact_id) or one chat (conversation_id) to hear when they ask (\"if Marco asks tonight, we're \
             at the ramen place\"): `text` in the user's words. When they ask, Pigeon writes the reply with it as a draft for the user (on \
             its own only for who holds passon.use.auto); once told it's gone, and `until` or `minutes` ends it unsaid. Only on the user's word.",
            json!({ "type": "object", "properties": {
                "contact_id": id("For this person"),
                "conversation_id": id("Or for this chat"),
                "text": { "type": "string", "description": "What they should hear" },
                "until": { "type": "string", "description": "Until when it holds, ISO 8601 with the offset" },
                "minutes": { "type": "integer", "description": "Or: for this many minutes" },
            }, "required": ["text"] }),
        ),
        (
            "pigeon_try_permission",
            "Before granting: try a permission (tool.level.mode) on what a person, a chat or a group's people wrote lately. Jev reads their \
             last messages one by one: which asked for it, and what Pigeon would have done with each (answer on its own, or ask the user). \
             Nothing is sent or changed. Slow (up to ~20 s).",
            json!({ "type": "object", "properties": {
                "contact_id": id("This person's messages"),
                "conversation_id": id("Or this chat's"),
                "group_id": id("Or this group's people's"),
                "group": { "type": "string", "description": "Or the group with this name" },
                "permission": { "type": "string", "description": "tool.level.mode, e.g. location.city.auto" },
                "limit": { "type": "integer", "description": "How many of their last messages (default 30, at most 60)" },
            }, "required": ["permission"] }),
        ),
        (
            "pigeon_mark_wrong",
            "\"That was wrong\": a reply told someone something it shouldn't have (action_id, from pigeon_tool_uses; `tool`: only that one \
             of what it used). The permissions behind it that let Pigeon answer on its own go back to ask, and the record says so.",
            json!({ "type": "object", "properties": {
                "action_id": id("The reply"),
                "tool": { "type": "string", "description": "Only this tool of what it used" },
            }, "required": ["action_id"] }),
        ),
        (
            "pigeon_connectors",
            "The Inbox's channels: each one available here or why not, the user's accounts on it and their health. Accounts are connected in the Inbox's settings.",
            json!({ "type": "object", "properties": {} }),
        ),
    ]
}

/// The tools that only read: an `inbox.read` key may run them.
const READS: &[&str] = &[
    "pigeon_inbox", "pigeon_search", "pigeon_conversation", "pigeon_pending", "pigeon_rules", "pigeon_rule_runs",
    "pigeon_actions", "pigeon_contacts", "pigeon_policies", "pigeon_connectors", "pigeon_access", "pigeon_permissions", "pigeon_groups",
    "pigeon_tool_uses", "pigeon_facts", "pigeon_try_permission",
];

/// The tools that decide who may be told what: their own scope, `inbox.access`.
const ACCESS: &[&str] = &["pigeon_set_group", "pigeon_grant", "pigeon_revoke", "pigeon_mark_wrong"];

/// The scope a key needs to run a tool from outside (the tools' API, MCP).
pub fn scope(name: &str) -> &'static str {
    if READS.contains(&name) {
        "inbox.read"
    } else if ACCESS.contains(&name) {
        "inbox.access"
    } else {
        "inbox.write"
    }
}

/// Every tool's name: what Piuma subscribes to.
pub fn names() -> Vec<&'static str> {
    defs().into_iter().map(|(n, _, _)| n).collect()
}

/// A tool called by Piuma: a big change becomes a confirmation card instead of running.
pub async fn call(st: &AppState, user: &str, name: &str, args: &Json) -> Result<Json, String> {
    let r: anyhow::Result<Json> = async {
        if let Some(tap) = confirm::needs_tap(st, user, name, args).await? {
            return confirm::ask(st, user, name, args, &tap).await;
        }
        run(st, user, name, args).await
    }
    .await;
    r.map_err(|e| format!("{e:#}"))
}

fn uuid_arg(args: &Json, name: &str) -> anyhow::Result<Uuid> {
    let s = args.get(name).and_then(Json::as_str).ok_or_else(|| anyhow::anyhow!("`{name}` is required"))?;
    Uuid::parse_str(s.trim()).map_err(|_| anyhow::anyhow!("`{name}` is not an id"))
}

pub fn opt_uuid(args: &Json, name: &str) -> anyhow::Result<Option<Uuid>> {
    match args.get(name).and_then(Json::as_str).filter(|s| !s.trim().is_empty()) {
        Some(_) => uuid_arg(args, name).map(Some),
        None => Ok(None),
    }
}

fn limit(args: &Json, default: i64, max: i64) -> i64 {
    args.get("limit").and_then(Json::as_i64).unwrap_or(default).clamp(1, max)
}

fn text<'a>(args: &'a Json, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// When something ends: `until` (ISO 8601 with the offset) or `minutes` from now; none: it doesn't.
fn until_arg(args: &Json) -> anyhow::Result<Option<chrono::DateTime<chrono::Utc>>> {
    Ok(match (text(args, "until"), args.get("minutes").and_then(Json::as_i64)) {
        (Some(u), _) => Some(chrono::DateTime::parse_from_rfc3339(u).map_err(|_| anyhow::anyhow!("`until`: ISO 8601 with the offset, not {u}"))?.to_utc()),
        (None, Some(m)) if m > 0 => Some(chrono::Utc::now() + chrono::Duration::minutes(m)),
        _ => None,
    })
}

/// The group a call names: `group_id`, or `group` (its name).
async fn group_arg(st: &State, user: &str, args: &Json) -> anyhow::Result<Option<Uuid>> {
    match (opt_uuid(args, "group_id")?, text(args, "group")) {
        (Some(id), _) => Ok(Some(access::find_group(st, user, &id.to_string()).await?.id)),
        (None, Some(name)) => Ok(Some(access::find_group(st, user, name).await?.id)),
        (None, None) => Ok(None),
    }
}

/// Whom an access call is about: a person, a chat, or a group (by id or name).
pub async fn holder_arg(st: &State, user: &str, args: &Json) -> anyhow::Result<Holder> {
    let mut found: Vec<Holder> = Vec::new();
    found.extend(opt_uuid(args, "contact_id")?.map(Holder::Contact));
    found.extend(opt_uuid(args, "conversation_id")?.map(Holder::Conversation));
    found.extend(group_arg(st, user, args).await?.map(Holder::Group));
    match found.as_slice() {
        [one] => Ok(*one),
        [] => anyhow::bail!("for whom: contact_id (a person), conversation_id (a chat) or group_id (a group)"),
        _ => anyhow::bail!("one of contact_id, conversation_id, group_id, not several"),
    }
}

/// What an access call gives or takes: `permission`, or `member_of` (a group's id or name).
pub async fn what_arg(st: &State, user: &str, args: &Json) -> anyhow::Result<What> {
    match (text(args, "permission"), text(args, "member_of")) {
        (Some(p), None) => Ok(What::Permission(p.to_string())),
        (None, Some(g)) => Ok(What::MemberOf(access::find_group(st, user, g).await?.id)),
        (Some(_), Some(_)) => anyhow::bail!("one of permission, member_of, not both"),
        (None, None) => anyhow::bail!("what: permission (tool.level.mode) or member_of (a group)"),
    }
}

/// One of the user's conversations, or an error naming it.
pub async fn own_conversation(st: &State, user: &str, id: Uuid) -> anyhow::Result<Conversation> {
    conversations::get(&st.pool, id).await?.filter(|c| c.user_id == user).ok_or_else(|| anyhow::anyhow!("no such conversation: {id}"))
}

async fn own_action(st: &State, user: &str, id: Uuid) -> anyhow::Result<Option<actions::ActionRow>> {
    Ok(actions::get(st, id).await?.filter(|a| a.user_id == user))
}

/// A tool, run (confirmed already, where it needed it).
pub async fn run(st: &AppState, user: &str, name: &str, args: &Json) -> anyhow::Result<Json> {
    match name {
        "pigeon_inbox" => inbox(st, user, args).await,
        "pigeon_search" => search(st, user, args).await,
        "pigeon_conversation" => conversation(st, user, args).await,
        "pigeon_mark_handled" => {
            let id = uuid_arg(args, "conversation_id")?;
            own_conversation(st, user, id).await?;
            mark_handled(st, id).await?;
            Ok(json!({ "handled": id }))
        }
        "pigeon_pending" => pending(st, user, limit(args, 50, 200)).await,
        "pigeon_draft_reply" => {
            let id = uuid_arg(args, "conversation_id")?;
            let conv = own_conversation(st, user, id).await?;
            if let Some(words) = text(args, "text") {
                let aid = actions::queue(st, user, &conv.connector, "send_reply", json!({ "text": words }), Some(id), "drafted with Piuma").await?;
                let row = actions::get(st, aid).await?.ok_or_else(|| anyhow::anyhow!("the draft vanished"))?;
                return Ok(json!({ "draft": actions::view(&row), "note": "A draft in the Inbox: the user sends it from there." }));
            }
            let out = agent::draft_reply(st, id, text(args, "instructions")).await?;
            let mut drafts = Vec::new();
            for o in &out {
                if let Some(aid) = o.id {
                    if let Some(r) = actions::get(st, aid).await? {
                        drafts.push(actions::view(&r));
                    }
                }
            }
            if drafts.is_empty() {
                anyhow::bail!("no reply was drafted (replies may be off for this conversation, or the model proposed none)");
            }
            Ok(json!({ "drafts": drafts, "note": "Drafts in the Inbox: the user sends them from there." }))
        }
        "pigeon_draft_email" => {
            let args = json!({ "to": text(args, "to"), "subject": text(args, "subject"), "text": text(args, "text"), "from": text(args, "from") });
            draft_email(st, user, args).await
        }
        "pigeon_send_reply" => {
            let id = uuid_arg(args, "conversation_id")?;
            let conv = own_conversation(st, user, id).await?;
            let words = text(args, "text").ok_or_else(|| anyhow::anyhow!("`text` is required: the exact words the user saw"))?;
            let aid = actions::queue(st, user, &conv.connector, "send_reply", json!({ "text": words }), Some(id), "sent from Piuma, on the user's word").await?;
            let row = actions::approve(st, aid, None, BY).await?;
            Ok(actions::view(&row))
        }
        "pigeon_edit_draft" => {
            let id = uuid_arg(args, "action_id")?;
            let words = text(args, "text").ok_or_else(|| anyhow::anyhow!("`text` is required"))?;
            own_action(st, user, id).await?.ok_or_else(|| anyhow::anyhow!("no such draft"))?;
            let row = actions::redraft(st, id, words).await?;
            Ok(json!({ "draft": actions::view(&row), "note": "Still a draft: the user sends it from the Inbox." }))
        }
        "pigeon_approve" => {
            let id = uuid_arg(args, "action_id")?;
            if own_action(st, user, id).await?.is_some() {
                let row = actions::approve(st, id, args.get("edits"), BY).await?;
                return Ok(actions::view(&row));
            }
            if rules::run_owner(st, id).await?.as_deref() == Some(user) {
                let run = rules::execute(st, id, BY).await?;
                return rules::view(st, &run).await;
            }
            anyhow::bail!("nothing waiting with that id")
        }
        "pigeon_drop" => {
            let id = uuid_arg(args, "action_id")?;
            let why = text(args, "why");
            if question_owner(st, id).await?.as_deref() == Some(user) {
                if let Some(q) = cards::drop_question(st, id).await? {
                    return Ok(q);
                }
            }
            if rules::run_owner(st, id).await?.as_deref() == Some(user) {
                let run = rules::drop(st, id, BY, why).await?;
                return rules::view(st, &run).await;
            }
            own_action(st, user, id).await?.ok_or_else(|| anyhow::anyhow!("nothing waiting with that id"))?;
            let row = actions::drop(st, id, BY, why).await?;
            if let Some(c) = row.conversation_id {
                crate::apps::pigeon::events::conversation(&st.pool, c).await;
            }
            Ok(actions::view(&row))
        }
        "pigeon_answer" => {
            let id = uuid_arg(args, "question_id")?;
            let answer = text(args, "answer").ok_or_else(|| anyhow::anyhow!("`answer` is required"))?;
            if question_owner(st, id).await?.as_deref() != Some(user) {
                anyhow::bail!("no such question");
            }
            if cards::is_uncovered(st, id).await? {
                // a 🔑 card: this time only (a draft), or no; allowing is pigeon_grant, then "granted"
                let button = match answer.trim().to_lowercase().as_str() {
                    "once" | "this once" => "once",
                    "granted" => "granted",
                    "no" | "x" => "x",
                    _ => anyhow::bail!("a 🔑 card takes `once` (Pigeon drafts the answer, this time only), `granted` (after pigeon_grant) or `no`"),
                };
                return Ok(json!({ "result": tell::press(st, user, id, button, None).await? }));
            }
            Ok(json!({ "result": cards::answer(st, id, answer, BY).await? }))
        }
        "pigeon_rules" => {
            let mut out = Vec::new();
            for r in rules::list(st, user).await? {
                let counts: Vec<(String, i64)> = sqlx::query_as(
                    "SELECT status, COUNT(*) FROM db_pigeon_rule_runs WHERE rule_id = $1 AND created_at > NOW() - INTERVAL '30 days' GROUP BY status",
                )
                .bind(r.id)
                .fetch_all(&st.pool)
                .await?;
                let mut v = serde_json::to_value(&r)?;
                v["runs_30_days"] = json!(counts.into_iter().map(|(k, n)| (k, json!(n))).collect::<serde_json::Map<_, _>>());
                out.push(v);
            }
            Ok(json!({ "rules": out }))
        }
        "pigeon_set_rule" => {
            let id = args.get("rule_id").and_then(Json::as_i64).map(|i| i as i32);
            let input = rule_input(st, user, id, args).await?;
            Ok(serde_json::to_value(rules::save(st, user, id, &input).await?)?)
        }
        "pigeon_delete_rule" => {
            let id = args.get("rule_id").and_then(Json::as_i64).ok_or_else(|| anyhow::anyhow!("`rule_id` is required"))? as i32;
            rules::mine(st, user, id).await?;
            sqlx::query("DELETE FROM db_pigeon_rules WHERE id = $1 AND user_id = $2").bind(id).bind(user).execute(&st.pool).await?;
            Ok(json!({ "deleted": id }))
        }
        "pigeon_try_rule" => {
            let id = args.get("rule_id").and_then(Json::as_i64).ok_or_else(|| anyhow::anyhow!("`rule_id` is required"))? as i32;
            let r = rules::mine(st, user, id).await?;
            let apply = args.get("apply").and_then(Json::as_bool).unwrap_or(false);
            rules::try_on_past(st, &r, limit(args, 3, 50), apply).await
        }
        "pigeon_rule_runs" => {
            let rule = args.get("rule_id").and_then(Json::as_i64).map(|i| i as i32);
            let mut out = Vec::new();
            for run in rules::runs(st, user, rule, text(args, "status"), limit(args, 20, 200)).await? {
                out.push(rules::view(st, &run).await?);
            }
            Ok(json!({ "runs": out }))
        }
        "pigeon_actions" => {
            let rows = actions::list(st, user, text(args, "status"), opt_uuid(args, "conversation_id")?, limit(args, 30, 200)).await?;
            Ok(json!({ "actions": rows.iter().map(actions::view).collect::<Vec<_>>() }))
        }
        "pigeon_contacts" => contacts(st, user, text(args, "query"), limit(args, 30, 200)).await,
        "pigeon_set_contact" => {
            let input: people::ContactInput = serde_json::from_value(args.clone()).map_err(|e| anyhow::anyhow!("arguments: {e}"))?;
            people::set_contact(st, user, input).await
        }
        "pigeon_set_note" => {
            let id = uuid_arg(args, "contact_id")?;
            let note = text(args, "note");
            let n = sqlx::query("UPDATE db_pigeon_contacts SET note = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2")
                .bind(id)
                .bind(user)
                .bind(note)
                .execute(&st.pool)
                .await?
                .rows_affected();
            if n == 0 {
                anyhow::bail!("no such contact");
            }
            Ok(json!({ "contact_id": id, "note": note }))
        }
        "pigeon_merge_contacts" => people::merge(st, user, uuid_arg(args, "contact_id")?, uuid_arg(args, "merge_id")?).await,
        "pigeon_names_from_whatsapp" => people::import_whatsapp(st, user, opt_uuid(args, "contact_id")?).await,
        "pigeon_learn" => {
            let days = |d: i64| args.get("days").and_then(Json::as_i64).unwrap_or(d).clamp(1, 3650);
            match opt_uuid(args, "contact_id")? {
                Some(id) => people::learn(st, user, id, days(365)).await,
                None => {
                    let d = days(90);
                    Ok(if people::learn_all(st.clone(), user.to_string(), d) {
                        json!({ "started": true, "days": d, "note": "Bringing in the conversations the user wrote in, then writing each person's memory and styles. It takes minutes; pigeon_contacts shows them as they come." })
                    } else {
                        json!({ "started": false, "note": "A learning run is going already." })
                    })
                }
            }
        }
        "pigeon_policies" => {
            let rows = policy::list(&st.pool, user).await?;
            Ok(json!({
                "auto_enabled": policy::auto_enabled(&st.pool, user).await?,
                "policies": rows.into_iter().map(|(scope, scope_id, kind, policy)| json!({ "scope": scope, "id": scope_id, "kind": kind, "policy": policy })).collect::<Vec<_>>(),
            }))
        }
        "pigeon_set_policy" => {
            let (kind, pol, scope, scope_id) = policy_args(st, user, args).await?;
            set_policy(st, user, kind, pol, scope, &scope_id).await
        }
        "pigeon_set_alerts" => {
            let level = text(args, "level").ok_or_else(|| anyhow::anyhow!("level: all, smart, quiet, off or inherit"))?;
            let level = if level == "inherit" { None } else { Some(alerts::Level::parse(level).ok_or_else(|| anyhow::anyhow!("level: all, smart, quiet, off or inherit"))?) };
            let (contact, conversation) = (opt_uuid(args, "contact_id")?, opt_uuid(args, "conversation_id")?);
            if let Some(c) = conversation {
                own_conversation(st, user, c).await?;
            }
            if let Some(c) = contact {
                people::mine(st, user, c).await?;
            }
            alerts::set(&st.pool, user, contact, conversation, level).await?;
            if let Some(c) = conversation {
                crate::apps::pigeon::events::conversation(&st.pool, c).await;
            }
            let scope = if conversation.is_some() { "conversation" } else if contact.is_some() { "contact" } else { "default" };
            Ok(json!({ "scope": scope, "level": level.map(alerts::Level::as_str).unwrap_or("inherit") }))
        }
        "pigeon_resume_auto" => {
            let ids: Vec<Uuid> = match (opt_uuid(args, "conversation_id")?, opt_uuid(args, "contact_id")?) {
                (Some(c), _) => {
                    own_conversation(st, user, c).await?;
                    vec![c]
                }
                (None, Some(person)) => sqlx::query_scalar("SELECT id FROM db_pigeon_conversations WHERE contact_id = $1 AND user_id = $2")
                    .bind(person)
                    .bind(user)
                    .fetch_all(&st.pool)
                    .await?,
                (None, None) => anyhow::bail!("conversation_id or contact_id is required"),
            };
            if ids.is_empty() {
                anyhow::bail!("no conversations for that person");
            }
            actions::resume_auto(st, &ids).await?;
            let mut out = Vec::new();
            for id in &ids {
                let Some(c) = conversations::get(&st.pool, *id).await? else { continue };
                let p = policy::resolve(&st.pool, user, Kind::Reply, c.contact_id, Some(c.id)).await?;
                out.push(json!({ "conversation_id": id, "channel": c.connector, "title": c.title, "reply_policy": p.as_str() }));
            }
            Ok(json!({ "resumed": out, "auto_enabled": policy::auto_enabled(&st.pool, user).await? }))
        }
        "pigeon_set_auto" => {
            let on = args.get("enabled").and_then(Json::as_bool).ok_or_else(|| anyhow::anyhow!("`enabled` is required"))?;
            policy::set_auto_enabled(&st.pool, user, on).await?;
            crate::apps::pigeon::events::publish(&st.pool, user, "settings", None).await;
            Ok(json!({ "auto_enabled": on }))
        }
        "pigeon_away" => {
            if args.get("end").and_then(Json::as_bool) == Some(true) {
                let was = away::end(st, user).await?;
                return Ok(json!({ "away": null, "ended": was }));
            }
            let Some(reason) = args.get("reason").and_then(Json::as_str) else {
                return Ok(json!({ "away": away::get(&st.pool, user).await? }));
            };
            Ok(json!({ "away": away::set(st, user, reason, until_arg(args)?).await? }))
        }
        "pigeon_access" => access::overview(st, user).await,
        "pigeon_permissions" => match holder_arg(st, user, args).await? {
            Holder::Contact(c) => access::of_contact(st, user, c).await,
            Holder::Conversation(c) => access::of_conversation(st, user, c).await,
            Holder::Group(g) => access::of_group(st, user, g).await,
        },
        "pigeon_groups" => match group_arg(st, user, args).await? {
            Some(g) => access::of_group(st, user, g).await,
            None => Ok(json!({ "groups": access::overview(st, user).await?["groups"] })),
        },
        "pigeon_set_group" => {
            let id = group_arg(st, user, args).await?;
            if args.get("delete").and_then(Json::as_bool) == Some(true) {
                let id = id.ok_or_else(|| anyhow::anyhow!("which group: group_id or group"))?;
                return Ok(json!({ "deleted": access::delete_group(st, user, id).await? }));
            }
            let g = access::save_group(st, user, id, text(args, "name"), args.get("description").and_then(Json::as_str)).await?;
            Ok(json!({ "group": g }))
        }
        "pigeon_grant" => {
            let h = holder_arg(st, user, args).await?;
            let what = what_arg(st, user, args).await?;
            Ok(json!({ "granted": access::grant(st, user, h, &what, until_arg(args)?, text(args, "said")).await? }))
        }
        "pigeon_revoke" => {
            let id = match opt_uuid(args, "grant_id")? {
                Some(id) => id,
                None => access::find_grant(st, user, holder_arg(st, user, args).await?, &what_arg(st, user, args).await?).await?,
            };
            Ok(json!({ "revoked": access::revoke(st, user, id).await? }))
        }
        "pigeon_pause_sharing" => {
            if args.get("end").and_then(Json::as_bool) == Some(true) {
                access::resume(st, user).await?;
                return Ok(json!({ "paused": null }));
            }
            let until = until_arg(args)?;
            if until.is_none() && args.get("pause").and_then(Json::as_bool) != Some(true) {
                return Ok(json!({ "paused": access::paused(&st.pool, user).await? }));
            }
            Ok(json!({ "paused": access::pause(st, user, until).await? }))
        }
        "pigeon_tool_uses" => tell::uses(st, user, opt_uuid(args, "contact_id")?, opt_uuid(args, "conversation_id")?, limit(args, 30, 200)).await,
        "pigeon_facts" => facts::all(st, user).await,
        "pigeon_set_fact" => {
            if args.get("delete").and_then(Json::as_bool) == Some(true) {
                return Ok(json!({ "deleted": facts::delete(st, user, uuid_arg(args, "fact_id")?).await?.id }));
            }
            let key = text(args, "key").ok_or_else(|| anyhow::anyhow!("`key` is required: location"))?;
            let (value, levels) = (args.get("value").unwrap_or(&Json::Null), args.get("levels").unwrap_or(&Json::Null));
            let f = facts::set(st, user, key, value, levels, text(args, "source").unwrap_or("user"), until_arg(args)?).await?;
            Ok(json!({ "fact": facts::views(&st.pool, &[f]).await?.pop() }))
        }
        "pigeon_passon" => {
            let h = holder_arg(st, user, args).await?;
            let words = text(args, "text").ok_or_else(|| anyhow::anyhow!("`text` is required: what they should hear"))?;
            let f = facts::leave(st, user, h, words, until_arg(args)?).await?;
            Ok(json!({ "fact": facts::views(&st.pool, &[f]).await?.pop() }))
        }
        "pigeon_try_permission" => {
            let h = holder_arg(st, user, args).await?;
            let permission = text(args, "permission").ok_or_else(|| anyhow::anyhow!("`permission` is required: tool.level.mode"))?;
            tell::try_on_past(st, user, h, permission, limit(args, 30, 60)).await
        }
        "pigeon_mark_wrong" => tell::wrong(st, user, uuid_arg(args, "action_id")?, text(args, "tool")).await,
        "pigeon_connectors" => connectors_view(st, user).await,
        other => anyhow::bail!("unknown tool: {other}"),
    }
}

/// A new email as a draft: the user's Send in the Inbox sends it.
pub async fn draft_email(st: &State, user: &str, args: Json) -> anyhow::Result<Json> {
    let aid = actions::queue(st, user, "gmail", "send", args, None, "drafted with Piuma").await?;
    let row = actions::get(st, aid).await?.ok_or_else(|| anyhow::anyhow!("the draft vanished"))?;
    crate::apps::pigeon::events::publish(&st.pool, user, "news", None).await;
    Ok(json!({ "draft": actions::view(&row), "note": "A draft in the Inbox (General): the user sends it from there." }))
}

pub async fn mark_handled(st: &State, id: Uuid) -> anyhow::Result<()> {
    sqlx::query("UPDATE db_pigeon_conversations SET attention = NULL, needs_note = NULL, handled_at = NOW(), updated_at = NOW() WHERE id = $1")
        .bind(id)
        .execute(&st.pool)
        .await?;
    crate::apps::pigeon::events::conversation(&st.pool, id).await;
    Ok(())
}

/// The user a question is for.
async fn question_owner(st: &State, id: Uuid) -> anyhow::Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT c.user_id FROM db_pigeon_questions q JOIN db_pigeon_conversations c ON c.id = q.conversation_id WHERE q.id = $1")
        .bind(id)
        .fetch_optional(&st.pool)
        .await?)
}

/// A policy's arguments: the kind, the policy (None: inherit), and its scope.
pub async fn policy_args(st: &State, user: &str, args: &Json) -> anyhow::Result<(Kind, Option<Policy>, &'static str, String)> {
    let kind = text(args, "kind").and_then(Kind::parse).ok_or_else(|| anyhow::anyhow!("kind: reply, record or organize"))?;
    let pol = text(args, "policy").ok_or_else(|| anyhow::anyhow!("policy: off, ask, auto or inherit"))?;
    let pol = if pol == "inherit" { None } else { Some(Policy::parse(pol).ok_or_else(|| anyhow::anyhow!("policy: off, ask, auto or inherit"))?) };
    let (scope, scope_id) = match (opt_uuid(args, "conversation_id")?, opt_uuid(args, "contact_id")?) {
        (Some(c), _) => {
            own_conversation(st, user, c).await?;
            ("conversation", c.to_string())
        }
        (None, Some(c)) => {
            people::mine(st, user, c).await?;
            ("contact", c.to_string())
        }
        (None, None) => ("default", String::new()),
    };
    Ok((kind, pol, scope, scope_id))
}

pub async fn set_policy(st: &State, user: &str, kind: Kind, pol: Option<Policy>, scope: &str, scope_id: &str) -> anyhow::Result<Json> {
    policy::set(&st.pool, user, scope, scope_id, kind, pol).await?;
    // a person's setting is theirs everywhere: their conversations' own settings of this kind go,
    // or an old one would still win over it
    let cleared = if scope == "contact" { policy::clear_conversations(&st.pool, scope_id, kind).await? } else { 0 };
    match scope {
        "conversation" => crate::apps::pigeon::events::conversation(&st.pool, Uuid::parse_str(scope_id)?).await,
        _ => crate::apps::pigeon::events::publish(&st.pool, user, "settings", None).await,
    }
    Ok(json!({ "scope": scope, "id": scope_id, "kind": kind.as_str(), "policy": pol.map(Policy::as_str).unwrap_or("inherit"), "conversation_settings_cleared": cleared }))
}

/// A rule from the arguments: those left out keep the rule's own value (or the default, for a
/// new one); empty clears.
pub async fn rule_input(st: &State, user: &str, id: Option<i32>, args: &Json) -> anyhow::Result<rules::RuleInput> {
    let before = match id {
        Some(i) => Some(rules::mine(st, user, i).await?),
        None => None,
    };
    let get = |k: &str| args.get(k).and_then(Json::as_str).map(str::trim).map(str::to_string);
    let opt = |k: &str, old: Option<String>| match get(k) {
        Some(v) if v.is_empty() => None,
        Some(v) => Some(v),
        None => old,
    };
    let b = before.as_ref();
    Ok(rules::RuleInput {
        name: get("name").or(b.map(|r| r.name.clone())).unwrap_or_default(),
        connector: get("connector").or(b.map(|r| r.connector.clone())).unwrap_or_else(|| "gmail".into()),
        sender: opt("sender", b.and_then(|r| r.sender.clone())),
        recipients: match args.get("recipients") {
            Some(Json::Null) => None,
            Some(v) => Some(serde_json::from_value::<rules::Recipients>(v.clone()).map_err(|e| anyhow::anyhow!("recipients: {e}"))?),
            None => b.and_then(|r| r.recipients.as_ref().map(|j| j.0.clone())),
        },
        contact_id: match get("contact_id") {
            Some(v) if v.is_empty() => None,
            Some(v) => Some(Uuid::parse_str(&v).map_err(|_| anyhow::anyhow!("`contact_id` is not an id"))?),
            None => b.and_then(|r| r.contact_id),
        },
        subject_has: opt("subject_has", b.and_then(|r| r.subject_has.clone())),
        expects: get("expects").or(b.map(|r| r.expects.clone())).unwrap_or_default(),
        record_tool: opt("record_tool", b.and_then(|r| r.record_tool.clone())),
        record_instructions: opt("record_instructions", b.and_then(|r| r.record_instructions.clone())),
        then_action: get("then_action").or(b.map(|r| r.then_action.clone())).unwrap_or_else(|| "none".into()),
        mode: get("mode").or(b.map(|r| r.mode.clone())).unwrap_or_else(|| "ask".into()),
    })
}

/// Everything waiting for the user.
pub async fn pending(st: &State, user: &str, limit: i64) -> anyhow::Result<Json> {
    actions::expire_due(st).await?;
    let rows = actions::list(st, user, Some("pending"), None, limit).await?;
    let mut out = Vec::new();
    for r in &rows {
        let mut v = actions::view(r);
        if let Some(cid) = r.conversation_id {
            if let Some(c) = conversations::get(&st.pool, cid).await? {
                let contact = conversations::contact(&st.pool, c.contact_id).await?;
                v["with"] = json!(conversations::who(contact.as_ref(), &c));
                v["channel"] = json!(c.connector);
            }
        }
        v["kind"] = json!(if r.kind == Kind::Reply.as_str() { "draft" } else { "suggestion" });
        out.push(v);
    }
    rules::expire_due(st).await?;
    for run in rules::runs(st, user, None, Some("pending"), limit).await? {
        out.push(rules::view(st, &run).await?);
    }
    out.extend(cards::open_questions(st, user).await?);
    out.extend(confirm::open(st, user).await?);
    Ok(json!({ "pending": out }))
}

async fn inbox(st: &State, user: &str, args: &Json) -> anyhow::Result<Json> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(Uuid, String, Option<String>, Option<String>, Option<f32>, Option<String>, Option<chrono::DateTime<chrono::Utc>>, Option<String>, Option<String>, Option<String>, i64)> =
        sqlx::query_as(
            "SELECT c.id, c.connector, c.title, c.attention, c.importance, c.kind, c.last_item_at, ct.name,
                    (SELECT i.body FROM db_pigeon_items i WHERE i.conversation_id = c.id ORDER BY i.at DESC LIMIT 1),
                    (SELECT i.author FROM db_pigeon_items i WHERE i.conversation_id = c.id ORDER BY i.at DESC LIMIT 1),
                    (SELECT COUNT(*) FROM db_pigeon_actions a WHERE a.conversation_id = c.id AND a.status = 'pending')
               FROM db_pigeon_conversations c LEFT JOIN db_pigeon_contacts ct ON ct.id = c.contact_id
              WHERE c.user_id = $5 AND ($1 OR c.attention IS NOT NULL)
                AND ($2::text IS NULL OR c.attention = $2)
                AND ($3::text IS NULL OR c.connector = $3)
              ORDER BY CASE c.attention WHEN 'reply' THEN 0 WHEN 'action' THEN 1 WHEN 'fyi' THEN 2 ELSE 3 END,
                       c.importance DESC NULLS LAST, c.last_item_at DESC NULLS LAST
              LIMIT $4",
        )
        .bind(args.get("include_handled").and_then(Json::as_bool).unwrap_or(false))
        .bind(text(args, "attention"))
        .bind(text(args, "connector"))
        .bind(limit(args, 30, 200))
        .bind(user)
        .fetch_all(&st.pool)
        .await?;
    let out: Vec<Json> = rows
        .into_iter()
        .map(|(id, connector, title, attention, importance, kind, last, name, body, author, pending)| {
            json!({
                "conversation_id": id,
                "channel": connector,
                "with": name.or(title.clone()),
                "title": title,
                "attention": attention,
                "importance": importance,
                "kind": kind,
                "last_at": last,
                "last_from": author,
                "preview": body.map(|b| conversations::clip(&b, 200)),
                "pending_actions": pending,
            })
        })
        .collect();
    Ok(json!({ "conversations": out }))
}

async fn search(st: &State, user: &str, args: &Json) -> anyhow::Result<Json> {
    let q = text(args, "query").ok_or_else(|| anyhow::anyhow!("`query` is required"))?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(Uuid, Uuid, String, String, Option<String>, Option<String>, Option<String>, String, chrono::DateTime<chrono::Utc>, Json)> = sqlx::query_as(
        "SELECT i.id, i.conversation_id, i.connector, i.author, i.sender, i.sender_name, i.subject, i.body, i.at, i.media
           FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
          WHERE c.user_id = $4 AND ($2::text IS NULL OR i.connector = $2)
            AND (to_tsvector('simple', coalesce(i.subject, '') || ' ' || i.body) @@ plainto_tsquery('simple', $1)
                 OR i.sender ILIKE '%' || $1 || '%' OR i.sender_name ILIKE '%' || $1 || '%' OR i.subject ILIKE '%' || $1 || '%')
          ORDER BY i.at DESC LIMIT $3",
    )
    .bind(q)
    .bind(text(args, "connector"))
    .bind(limit(args, 20, 100))
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    let out: Vec<Json> = rows
        .into_iter()
        .map(|(id, conv, connector, author, sender, name, subject, body, at, files)| {
            with_files(
                json!({ "item_id": id, "conversation_id": conv, "channel": connector, "author": author, "from": name.or(sender),
                        "subject": subject, "text": conversations::clip(&body, 300), "at": at }),
                &files,
            )
        })
        .collect();
    Ok(json!({ "results": out }))
}

/// A message as a tool tells it, with its files when it has any.
fn with_files(mut message: Json, files: &Json) -> Json {
    let files = media::told(files);
    if !files.is_empty() {
        message["files"] = json!(files);
    }
    message
}

async fn conversation(st: &State, user: &str, args: &Json) -> anyhow::Result<Json> {
    let id = uuid_arg(args, "conversation_id")?;
    let conv = own_conversation(st, user, id).await?;
    let contact = conversations::contact(&st.pool, conv.contact_id).await?;
    let n = args.get("items").and_then(Json::as_i64).unwrap_or(20).clamp(1, 200);
    let items = conversations::recent_items(&st.pool, id, n).await?;
    let summary = match agent::summary(st, &conv).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("pigeon summary of {id}: {e:#}");
            conv.summary.clone()
        }
    };
    let mut pols = serde_json::Map::new();
    for k in [Kind::Reply, Kind::Record, Kind::Organize] {
        let p = policy::resolve(&st.pool, user, k, conv.contact_id, Some(id)).await?;
        pols.insert(k.as_str().into(), json!(p.as_str()));
    }
    let waiting = cards::list(st, user, Some(id)).await?;
    Ok(json!({
        "conversation": conv,
        "with": conversations::who(contact.as_ref(), &conv),
        "contact": contact,
        "what_pigeon_knows_about_them": match &contact { Some(c) => people::memory(st, c.id).await?.map(|m| m.memory), None => None },
        "how_the_user_writes_to_them_here": match &contact { Some(c) => people::style(st, c.id, &conv.connector).await?.map(|s| s.profile), None => None },
        "summary": summary,
        "policies": pols,
        "alerts": alerts::resolve(&st.pool, user, conv.contact_id, Some(id)).await?.as_str(),
        "waiting": waiting,
        "items": items.iter().map(|i| with_files(json!({
            "id": i.id, "at": i.at, "author": i.author, "from": i.sender_name.clone().or(i.sender.clone()),
            "subject": i.subject, "text": conversations::clip(&i.body, 4000),
        }), &i.media)).collect::<Vec<_>>(),
    }))
}

pub async fn contacts(st: &State, user: &str, q: Option<&str>, limit: i64) -> anyhow::Result<Json> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT c.id FROM db_pigeon_contacts c
          WHERE c.user_id = $3 AND ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR c.relationship ILIKE '%' || $1 || '%'
             OR c.slug = lower(ltrim($1, '@'))
             OR EXISTS (SELECT 1 FROM db_pigeon_contact_handles h WHERE h.contact_id = c.id AND (h.handle ILIKE '%' || $1 || '%' OR h.display_name ILIKE '%' || $1 || '%')))
          ORDER BY c.updated_at DESC LIMIT $2",
    )
    .bind(q)
    .bind(limit)
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    let mut out = Vec::new();
    for id in ids {
        out.push(people::view(st, user, id).await?);
    }
    Ok(json!({ "contacts": out }))
}

/// Each channel: available or why not, the user's accounts on it and their health.
pub async fn connectors_view(st: &State, user: &str) -> anyhow::Result<Json> {
    let mut out = Vec::new();
    for c in &st.connectors {
        let available = c.available(st);
        out.push(json!({
            "id": c.id(),
            "title": c.title(),
            "available": available.is_ok(),
            "why_not": available.as_ref().err(),
            "connects_by_link": c.connects_by_link(),
            "connects_by_pairing": c.connects_by_pairing(),
            "health": if available.is_ok() { c.health(st, user).await } else { Json::Null },
        }));
    }
    Ok(json!({ "connectors": out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_named_once_and_described() {
        let defs = defs();
        let mut names: Vec<&str> = defs.iter().map(|(n, _, _)| *n).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), defs.len());
        assert!(defs.iter().all(|(n, d, s)| n.starts_with("pigeon_") && !d.is_empty() && s["type"] == "object"));
    }
}

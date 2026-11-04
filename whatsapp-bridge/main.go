// pigeon-whatsapp: the vault users' WhatsApp for Pigeon, each as a linked device (like WhatsApp
// Web) through whatsmeow, one session per user. It holds the sessions (SQLite on its volume) and
// nothing else: every message a session sees, the user's own from the phone included, goes to
// the vault's webhook (signed with the shared secret, tagged with the user), and the vault asks it
// to send, to show "typing…", or for the QR code to pair with.
//
// A session stays offline (no "online" to the user's contacts, and their phone keeps its
// notifications); it goes online only while Pigeon is writing an auto reply, which is also when
// WhatsApp tells it the other person is typing (passed on, so Pigeon waits for them to finish).
//
// API (Authorization: Bearer <PIGEON_WHATSAPP_BRIDGE_SECRET>; /health is open), per vault user:
//
//	GET  /u/{user}/status   {state, phone, name}
//	GET  /u/{user}/pair     the QR code to scan (pairing starts if it isn't), or connected
//	POST /u/{user}/send     {chat, text} → {id, at}
//	POST /u/{user}/typing   {chat, on}
//	POST /u/{user}/logout
//	GET  /u/{user}/contacts the address book: {contacts: [{phone, name, push, business}]}
//	POST /u/{user}/media    a file's download details (a message's `files` entry) → the file
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

// How long a session stays online after Pigeon last asked for "typing…" or sent.
const onlineFor = 45 * time.Second

// bridge: what the sessions share.
type bridge struct {
	secret  string
	webhook string
	// history brought in on pairing: messages of the last days, the latest per chat (0: all)
	historyDays    int
	historyPerChat int

	db    *sql.DB
	store *sqlstore.Container
	log   waLog.Logger

	mu       sync.Mutex
	sessions map[string]*session

	out chan []byte
}

// session: one vault user's WhatsApp.
type session struct {
	b    *bridge
	user string

	mu      sync.Mutex
	cli     *whatsmeow.Client
	pairing bool
	qr      string
	online  *time.Timer
	groups  map[types.JID]string
	// the history so far, for the log
	historyChats, historyMessages int
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	n, err := strconv.Atoi(env(k, ""))
	if err != nil {
		return def
	}
	return n
}

func main() {
	secret := env("PIGEON_WHATSAPP_BRIDGE_SECRET", "")
	if len(secret) < 16 {
		log.Fatal("PIGEON_WHATSAPP_BRIDGE_SECRET is required (16 characters at least)")
	}
	// how it shows on the phone (Linked devices): "Pigeon", a desktop
	store.SetOSInfo(env("WHATSAPP_DEVICE_NAME", "Pigeon"), [3]uint32{1, 0, 0})
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
	// the history the phone sends when it links a device (read at pairing only: a change needs
	// the QR code scanned again): the full one, as WhatsApp Desktop asks, back this many days
	historyDays := envInt("WHATSAPP_HISTORY_DAYS", 365)
	if env("WHATSAPP_FULL_SYNC", "1") == "1" {
		store.DeviceProps.RequireFullSync = proto.Bool(true)
		store.DeviceProps.HistorySyncConfig.FullSyncDaysLimit = proto.Uint32(uint32(historyDays))
	}
	dataDir := env("WHATSAPP_DATA", "/data")
	db, err := sql.Open("sqlite", "file:"+dataDir+"/whatsapp.db?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		log.Fatalf("session database: %v", err)
	}
	db.SetMaxOpenConns(1)
	wlog := waLog.Stdout("whatsmeow", env("WHATSAPP_LOG_LEVEL", "WARN"), false)
	container := sqlstore.NewWithDB(db, "sqlite", wlog.Sub("store"))
	if err := container.Upgrade(context.Background()); err != nil {
		log.Fatalf("session database: %v", err)
	}
	// whose each device is
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS pigeon_sessions (user_id TEXT PRIMARY KEY, jid TEXT NOT NULL)`); err != nil {
		log.Fatalf("session database: %v", err)
	}
	b := &bridge{
		secret:         secret,
		webhook:        env("PIGEON_WEBHOOK_URL", "http://rust:8080/pigeon/webhooks/whatsapp"),
		historyDays:    historyDays,
		historyPerChat: envInt("WHATSAPP_HISTORY_PER_CHAT", 0),
		db:             db,
		store:          container,
		log:            wlog,
		sessions:       map[string]*session{},
		out:            make(chan []byte, 1000),
	}
	go b.deliver()
	if err := b.resume(); err != nil {
		log.Fatalf("sessions: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /u/{user}/status", b.auth((*session).status))
	mux.HandleFunc("GET /u/{user}/pair", b.auth((*session).pair))
	mux.HandleFunc("POST /u/{user}/send", b.auth((*session).send))
	mux.HandleFunc("POST /u/{user}/typing", b.auth((*session).typing))
	mux.HandleFunc("POST /u/{user}/logout", b.auth((*session).logout))
	mux.HandleFunc("GET /u/{user}/contacts", b.auth((*session).contacts))
	mux.HandleFunc("POST /u/{user}/media", b.auth((*session).media))
	addr := env("WHATSAPP_BIND", ":8080")
	log.Printf("listening on %s, events to %s", addr, b.webhook)
	log.Fatal(http.ListenAndServe(addr, mux))
}

// ── the sessions ─────────────────────────────────────────────────────────

// resume: every paired session, connected again.
func (b *bridge) resume() error {
	rows, err := b.db.Query(`SELECT user_id, jid FROM pigeon_sessions`)
	if err != nil {
		return err
	}
	type pair struct{ user, jid string }
	var paired []pair
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.user, &p.jid); err != nil {
			rows.Close()
			return err
		}
		paired = append(paired, p)
	}
	rows.Close()
	for _, p := range paired {
		jid, err := types.ParseJID(p.jid)
		if err != nil {
			log.Printf("session of %s: %v", p.user, err)
			continue
		}
		device, err := b.store.GetDevice(context.Background(), jid)
		if err != nil || device == nil {
			log.Printf("session of %s: its device is gone, pair again", p.user)
			b.forget(p.user)
			continue
		}
		s := b.newSession(p.user, device)
		if err := s.client().Connect(); err != nil {
			log.Printf("session of %s: connect: %v (whatsmeow retries)", p.user, err)
		}
	}
	log.Printf("%d session(s) resumed", len(paired))
	return nil
}

// session: the user's, made (unpaired) on first use.
func (b *bridge) session(user string) *session {
	b.mu.Lock()
	s, ok := b.sessions[user]
	b.mu.Unlock()
	if ok {
		return s
	}
	return b.newSession(user, b.store.NewDevice())
}

func (b *bridge) newSession(user string, device *store.Device) *session {
	s := &session{b: b, user: user, groups: map[types.JID]string{}}
	s.setDevice(device)
	b.mu.Lock()
	defer b.mu.Unlock()
	if old, ok := b.sessions[user]; ok {
		return old
	}
	b.sessions[user] = s
	return s
}

// remember: the user's device, once paired.
func (b *bridge) remember(user string, jid types.JID) {
	if _, err := b.db.Exec(`INSERT INTO pigeon_sessions (user_id, jid) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET jid = excluded.jid`, user, jid.String()); err != nil {
		log.Printf("session of %s: %v", user, err)
	}
}

func (b *bridge) forget(user string) {
	if _, err := b.db.Exec(`DELETE FROM pigeon_sessions WHERE user_id = ?`, user); err != nil {
		log.Printf("session of %s: %v", user, err)
	}
}

func (s *session) client() *whatsmeow.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cli
}

func (s *session) setDevice(device *store.Device) {
	cli := whatsmeow.NewClient(device, s.b.log.Sub("client"))
	cli.AddEventHandler(s.onEvent)
	s.mu.Lock()
	s.cli = cli
	s.mu.Unlock()
}

func (s *session) onEvent(evt any) {
	ctx := context.Background()
	switch e := evt.(type) {
	case *events.PairSuccess:
		s.b.remember(s.user, e.ID)
	case *events.Connected:
		cli := s.client()
		log.Printf("%s: connected as %s", s.user, cli.Store.ID)
		s.b.remember(s.user, *cli.Store.ID)
		// offline: their phone keeps its notifications (also tells WhatsApp their name)
		if err := cli.SendPresence(ctx, types.PresenceUnavailable); err != nil && !errors.Is(err, whatsmeow.ErrNoPushName) {
			log.Printf("%s: presence: %v", s.user, err)
		}
		s.emit(map[string]any{"type": "connected", "phone": phone(*cli.Store.ID), "name": cli.Store.PushName})
	case *events.PushNameSetting:
		_ = s.client().SendPresence(ctx, types.PresenceUnavailable)
	case *events.LoggedOut:
		log.Printf("%s: logged out (%v): pair again", s.user, e.Reason)
		s.emit(map[string]any{"type": "logged_out", "reason": e.Reason.String()})
		s.b.forget(s.user)
		s.setDevice(s.b.store.NewDevice())
	case *events.TemporaryBan:
		log.Printf("%s: WhatsApp banned this number for a while: %v", s.user, e)
		s.emit(map[string]any{"type": "temporary_ban", "reason": e.String()})
	case *events.Message:
		if m := s.message(ctx, e); m != nil {
			s.emit(map[string]any{"type": "message", "message": m})
		}
	case *events.HistorySync:
		s.history(ctx, e)
	case *events.ChatPresence:
		if e.IsFromMe {
			return
		}
		s.emit(map[string]any{"type": "typing", "chat": s.chatOf(ctx, &e.MessageSource).String(), "state": string(e.State)})
	}
}

// ── what goes to the vault ───────────────────────────────────────────────

type message struct {
	ID         string   `json:"id"`
	Chat       string   `json:"chat"`
	ChatName   string   `json:"chat_name,omitempty"`
	Group      bool     `json:"group"`
	FromMe     bool     `json:"from_me"`
	Sender     string   `json:"sender"`
	SenderName string   `json:"sender_name,omitempty"`
	Text       string   `json:"text"`
	At         int64    `json:"at"`
	Kinds      []string `json:"kinds,omitempty"`
	Files      []file   `json:"files,omitempty"`
}

// file: a photo, video, voice note, document or sticker on a message: what it is, the tiny
// preview WhatsApp sends with it, and what POST /u/{user}/media needs to fetch it (WhatsApp keeps
// it for some weeks).
type file struct {
	Kind      string `json:"kind"` // image, video, voice, audio, document, sticker
	Mime      string `json:"mime,omitempty"`
	Name      string `json:"name,omitempty"`
	Size      uint64 `json:"size,omitempty"`
	Seconds   uint32 `json:"seconds,omitempty"`
	Width     uint32 `json:"width,omitempty"`
	Height    uint32 `json:"height,omitempty"`
	Thumb     []byte `json:"thumb,omitempty"` // a small JPEG
	Path      string `json:"direct_path"`
	MediaKey  []byte `json:"media_key"`
	EncSHA256 []byte `json:"enc_sha256"`
	SHA256    []byte `json:"sha256"`
	MediaType string `json:"media_type"`
}

// fileOf: a downloadable part of a message as a file.
func fileOf(kind string, m whatsmeow.DownloadableMessage, mime, name string, size uint64) file {
	return file{
		Kind: kind, Mime: mime, Name: name, Size: size,
		Path: m.GetDirectPath(), MediaKey: m.GetMediaKey(), EncSHA256: m.GetFileEncSHA256(), SHA256: m.GetFileSHA256(),
		MediaType: string(whatsmeow.GetMediaType(m)),
	}
}

// pn: a hidden user id (LID) as the phone number's JID when WhatsApp has told which.
func (s *session) pn(ctx context.Context, j types.JID) types.JID {
	j = j.ToNonAD()
	if j.Server == types.HiddenUserServer {
		if p, err := s.client().Store.LIDs.GetPNForLID(ctx, j); err == nil && !p.IsEmpty() {
			return p.ToNonAD()
		}
	}
	return j
}

// chatOf: the chat as Pigeon keys it, a one-to-one chat by the other person's phone number.
func (s *session) chatOf(ctx context.Context, src *types.MessageSource) types.JID {
	c := src.Chat.ToNonAD()
	if c.Server != types.HiddenUserServer {
		return c
	}
	if !src.IsFromMe && src.SenderAlt.Server == types.DefaultUserServer {
		return src.SenderAlt.ToNonAD()
	}
	if src.IsFromMe && src.RecipientAlt.Server == types.DefaultUserServer {
		return src.RecipientAlt.ToNonAD()
	}
	return s.pn(ctx, c)
}

func (s *session) senderOf(ctx context.Context, src *types.MessageSource) types.JID {
	if src.Sender.Server == types.HiddenUserServer && src.SenderAlt.Server == types.DefaultUserServer {
		return src.SenderAlt.ToNonAD()
	}
	return s.pn(ctx, src.Sender)
}

// phone: "+<number>" for a phone number's JID, else the JID.
func phone(j types.JID) string {
	if j.Server == types.DefaultUserServer {
		return "+" + j.User
	}
	return j.ToNonAD().String()
}

// name: how the user saved them, else the name they gave themselves.
func (s *session) name(ctx context.Context, j types.JID, pushName string) string {
	if c, err := s.client().Store.Contacts.GetContact(ctx, j); err == nil && c.Found {
		for _, n := range []string{c.FullName, c.FirstName, c.BusinessName, c.PushName} {
			if strings.TrimSpace(n) != "" {
				return n
			}
		}
	}
	return pushName
}

func (s *session) groupName(ctx context.Context, j types.JID) string {
	s.mu.Lock()
	n, ok := s.groups[j]
	s.mu.Unlock()
	if ok {
		return n
	}
	if info, err := s.client().GetGroupInfo(ctx, j); err == nil {
		n = info.Name
		s.mu.Lock()
		s.groups[j] = n
		s.mu.Unlock()
	}
	return n
}

// skipped: statuses, channels, broadcast lists.
func skipped(chat types.JID) bool {
	return chat.Server == types.BroadcastServer || chat.Server == types.NewsletterServer || chat == types.StatusBroadcastJID
}

func (s *session) message(ctx context.Context, e *events.Message) *message {
	if skipped(e.Info.Chat) {
		return nil
	}
	text, kinds, files := content(e.Message)
	if text == "" && len(kinds) == 0 {
		return nil // reactions, edits, deletions, receipts of polls: not messages
	}
	chat := s.chatOf(ctx, &e.Info.MessageSource)
	sender := s.senderOf(ctx, &e.Info.MessageSource)
	m := &message{
		ID:     chat.String() + "/" + e.Info.ID,
		Chat:   chat.String(),
		Group:  e.Info.IsGroup,
		FromMe: e.Info.IsFromMe,
		Sender: phone(sender),
		Text:   text,
		At:     e.Info.Timestamp.UnixMilli(),
		Kinds:  kinds,
		Files:  files,
	}
	if !e.Info.IsFromMe {
		m.SenderName = s.name(ctx, sender, e.Info.PushName)
	}
	switch {
	case e.Info.IsGroup:
		m.ChatName = s.groupName(ctx, chat)
	case e.Info.IsFromMe:
		m.ChatName = s.name(ctx, chat, "")
	default:
		m.ChatName = m.SenderName
	}
	return m
}

// content: a message's text, what's attached to it (in words), and its files.
func content(msg *waE2E.Message) (string, []string, []file) {
	if msg == nil {
		return "", nil, nil
	}
	var kinds []string
	var files []file
	text := msg.GetConversation()
	if t := msg.GetExtendedTextMessage().GetText(); t != "" {
		text = t
	}
	if m := msg.GetImageMessage(); m != nil {
		kinds, text = append(kinds, "image"), m.GetCaption()
		f := fileOf("image", m, m.GetMimetype(), "", m.GetFileLength())
		f.Width, f.Height, f.Thumb = m.GetWidth(), m.GetHeight(), m.GetJPEGThumbnail()
		files = append(files, f)
	}
	if m := msg.GetVideoMessage(); m != nil {
		kinds, text = append(kinds, "video"), m.GetCaption()
		f := fileOf("video", m, m.GetMimetype(), "", m.GetFileLength())
		f.Width, f.Height, f.Seconds, f.Thumb = m.GetWidth(), m.GetHeight(), m.GetSeconds(), m.GetJPEGThumbnail()
		files = append(files, f)
	}
	if m := msg.GetAudioMessage(); m != nil {
		kinds = append(kinds, map[bool]string{true: "voice message", false: "audio"}[m.GetPTT()])
		f := fileOf(map[bool]string{true: "voice", false: "audio"}[m.GetPTT()], m, m.GetMimetype(), "", m.GetFileLength())
		f.Seconds = m.GetSeconds()
		files = append(files, f)
	}
	if m := msg.GetDocumentMessage(); m != nil {
		kinds, text = append(kinds, "document: "+m.GetFileName()), m.GetCaption()
		f := fileOf("document", m, m.GetMimetype(), m.GetFileName(), m.GetFileLength())
		f.Thumb = m.GetJPEGThumbnail()
		files = append(files, f)
	}
	if m := msg.GetStickerMessage(); m != nil {
		kinds = append(kinds, "sticker")
		f := fileOf("sticker", m, m.GetMimetype(), "", m.GetFileLength())
		f.Width, f.Height = m.GetWidth(), m.GetHeight()
		files = append(files, f)
	}
	if m := msg.GetLocationMessage(); m != nil {
		kinds = append(kinds, fmt.Sprintf("location: %s %.5f,%.5f", m.GetName(), m.GetDegreesLatitude(), m.GetDegreesLongitude()))
	}
	if m := msg.GetContactMessage(); m != nil {
		kinds = append(kinds, "contact: "+m.GetDisplayName())
	}
	for _, p := range []*waE2E.PollCreationMessage{msg.GetPollCreationMessage(), msg.GetPollCreationMessageV3()} {
		if p != nil {
			kinds = append(kinds, "poll: "+p.GetName())
		}
	}
	return strings.TrimSpace(text), kinds, files
}

// history: what WhatsApp sends after pairing, in chunks over minutes (a full sync can be a year of
// chats), to the vault as history (stored, never answered). Batches stay under the vault's body
// limit, and wait for it rather than being dropped.
func (s *session) history(ctx context.Context, e *events.HistorySync) {
	since := time.Now().AddDate(0, 0, -s.b.historyDays)
	var batch []*message
	size := 0
	flush := func() {
		if len(batch) > 0 {
			s.emitWait(map[string]any{"type": "history", "messages": batch})
			batch, size = nil, 0
		}
	}
	chats, kept := 0, 0
	for _, conv := range e.Data.GetConversations() {
		chat, err := types.ParseJID(conv.GetID())
		if err != nil || skipped(chat) {
			continue
		}
		chats++
		n := 0
		for _, hm := range conv.GetMessages() {
			if s.b.historyPerChat > 0 && n >= s.b.historyPerChat {
				break
			}
			evt, err := s.client().ParseWebMessage(chat, hm.GetMessage())
			if err != nil || evt.Info.Timestamp.Before(since) {
				continue
			}
			if m := s.message(ctx, evt); m != nil {
				if m.ChatName == "" {
					m.ChatName = conv.GetName()
				}
				batch, n = append(batch, m), n+1
				size += len(m.Text) + len(m.ChatName) + len(m.SenderName) + 300
				for _, f := range m.Files {
					size += len(f.Thumb)*4/3 + 400
				}
				if len(batch) >= 500 || size >= 600_000 {
					flush()
				}
			}
		}
		kept += n
	}
	flush()
	s.mu.Lock()
	s.historyChats += chats
	s.historyMessages += kept
	total := s.historyMessages
	s.mu.Unlock()
	log.Printf("%s: history %s chunk %d, progress %d%%: %d chats, %d messages kept (%d so far)",
		s.user, e.Data.GetSyncType(), e.Data.GetChunkOrder(), e.Data.GetProgress(), chats, kept, total)
}

// event: what goes to the vault, the user's.
func (s *session) event(v map[string]any) []byte {
	v["user"] = s.user
	body, err := json.Marshal(v)
	if err != nil {
		log.Printf("event: %v", err)
		return nil
	}
	return body
}

// emitWait: an event that mustn't be lost (history): it waits for room instead of being dropped.
func (s *session) emitWait(v map[string]any) {
	if body := s.event(v); body != nil {
		s.b.out <- body
	}
}

func (s *session) emit(v map[string]any) {
	body := s.event(v)
	if body == nil {
		return
	}
	select {
	case s.b.out <- body:
	default:
		log.Printf("event dropped: the vault is behind")
	}
}

// deliver: events to the vault one after the other (in order), each tried until it takes it.
func (b *bridge) deliver() {
	client := &http.Client{Timeout: 30 * time.Second}
	for body := range b.out {
		mac := hmac.New(sha256.New, []byte(b.secret))
		mac.Write(body)
		sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))
		// until the vault takes it (a deploy restarts it): backoff up to a minute
		for attempt := 0; ; attempt++ {
			req, _ := http.NewRequest("POST", b.webhook, bytes.NewReader(body))
			req.Header.Set("content-type", "application/json")
			req.Header.Set("x-hub-signature-256", sig)
			resp, err := client.Do(req)
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode < 300 {
					break
				}
				// refused for good (the signature, too large): trying again won't change it
				if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != 429 {
					log.Printf("to the vault: HTTP %d, event left", resp.StatusCode)
					break
				}
				err = fmt.Errorf("HTTP %d", resp.StatusCode)
			}
			log.Printf("to the vault: %v", err)
			time.Sleep(time.Duration(1<<min(attempt, 6)) * time.Second)
		}
	}
}

// ── the API ──────────────────────────────────────────────────────────────

// auth: the shared secret, then the path's user's session.
func (b *bridge) auth(h func(*session, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	want := []byte("Bearer " + b.secret)
	return func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("authorization")), want) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		user := strings.TrimSpace(r.PathValue("user"))
		if user == "" {
			http.Error(w, "no user", http.StatusBadRequest)
			return
		}
		h(b.session(user), w, r)
	}
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, err error) {
	reply(w, status, map[string]string{"error": err.Error()})
}

func (s *session) state() map[string]any {
	cli := s.client()
	s.mu.Lock()
	pairing := s.pairing
	s.mu.Unlock()
	switch {
	case cli.Store.ID != nil && cli.IsLoggedIn():
		return map[string]any{"state": "connected", "phone": phone(*cli.Store.ID), "name": cli.Store.PushName}
	case cli.Store.ID != nil:
		return map[string]any{"state": "disconnected", "phone": phone(*cli.Store.ID), "name": cli.Store.PushName}
	case pairing:
		return map[string]any{"state": "pairing"}
	default:
		return map[string]any{"state": "not_paired"}
	}
}

func (s *session) status(w http.ResponseWriter, _ *http.Request) {
	reply(w, http.StatusOK, s.state())
}

// contacts: the user's WhatsApp address book, as the phone shares it with linked devices:
// each person by phone number, with how the user saved them (name), the name they gave
// themselves (push) and a business's name.
func (s *session) contacts(w http.ResponseWriter, r *http.Request) {
	cli := s.client()
	if cli.Store.ID == nil {
		fail(w, http.StatusConflict, fmt.Errorf("not linked"))
		return
	}
	all, err := cli.Store.Contacts.GetAllContacts(r.Context())
	if err != nil {
		fail(w, http.StatusInternalServerError, err)
		return
	}
	type entry struct {
		Phone    string `json:"phone"`
		Name     string `json:"name,omitempty"`
		Push     string `json:"push,omitempty"`
		Business string `json:"business,omitempty"`
	}
	out := []entry{}
	for j, c := range all {
		j = s.pn(r.Context(), j)
		if j.Server != types.DefaultUserServer {
			continue
		}
		name := strings.TrimSpace(c.FullName)
		if name == "" {
			name = strings.TrimSpace(c.FirstName)
		}
		out = append(out, entry{Phone: phone(j), Name: name, Push: strings.TrimSpace(c.PushName), Business: strings.TrimSpace(c.BusinessName)})
	}
	reply(w, http.StatusOK, map[string]any{"contacts": out})
}

// pair: the current QR code (as a PNG, base64), starting the pairing if it isn't running.
func (s *session) pair(w http.ResponseWriter, _ *http.Request) {
	cli := s.client()
	if cli.Store.ID != nil {
		reply(w, http.StatusOK, s.state())
		return
	}
	s.mu.Lock()
	start := !s.pairing
	if start {
		s.pairing, s.qr = true, ""
	}
	qr := s.qr
	s.mu.Unlock()
	if start {
		if err := s.startPairing(cli); err != nil {
			s.mu.Lock()
			s.pairing = false
			s.mu.Unlock()
			fail(w, http.StatusBadGateway, err)
			return
		}
	}
	if qr == "" {
		reply(w, http.StatusOK, map[string]any{"state": "pairing"})
		return
	}
	png, err := qrcode.Encode(qr, qrcode.Medium, 320)
	if err != nil {
		fail(w, http.StatusInternalServerError, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"state": "pairing", "qr_png": base64.StdEncoding.EncodeToString(png)})
}

func (s *session) startPairing(cli *whatsmeow.Client) error {
	if cli.IsConnected() {
		cli.Disconnect()
	}
	ch, err := cli.GetQRChannel(context.Background())
	if err != nil {
		return err
	}
	if err := cli.Connect(); err != nil {
		return err
	}
	go func() {
		for item := range ch {
			s.mu.Lock()
			if item.Event == "code" {
				s.qr = item.Code
				s.mu.Unlock()
				continue
			}
			s.pairing, s.qr = false, ""
			s.mu.Unlock()
			log.Printf("%s: pairing: %s", s.user, item.Event)
			if item.Event != "success" {
				cli.Disconnect() // the next /pair starts again
			}
		}
	}()
	return nil
}

func (s *session) loggedIn(w http.ResponseWriter) *whatsmeow.Client {
	cli := s.client()
	if cli.Store.ID == nil || !cli.IsLoggedIn() {
		fail(w, http.StatusServiceUnavailable, errors.New("WhatsApp isn't connected: pair it in the Inbox's settings"))
		return nil
	}
	return cli
}

// goOnline for a while: "typing…" is only shown, and their typing only told, while online.
func (s *session) goOnline(ctx context.Context, cli *whatsmeow.Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.online != nil {
		s.online.Reset(onlineFor)
		return
	}
	if err := cli.SendPresence(ctx, types.PresenceAvailable); err != nil {
		log.Printf("%s: presence: %v", s.user, err)
		return
	}
	s.online = time.AfterFunc(onlineFor, func() {
		s.mu.Lock()
		s.online = nil
		s.mu.Unlock()
		_ = cli.SendPresence(context.Background(), types.PresenceUnavailable)
	})
}

type sendReq struct {
	Chat string `json:"chat"`
	Text string `json:"text"`
	On   bool   `json:"on"`
}

func readReq(w http.ResponseWriter, r *http.Request) (*sendReq, types.JID, bool) {
	var req sendReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, err)
		return nil, types.JID{}, false
	}
	jid, err := types.ParseJID(req.Chat)
	if err != nil || jid.User == "" {
		fail(w, http.StatusBadRequest, fmt.Errorf("chat: a WhatsApp JID, not %q", req.Chat))
		return nil, types.JID{}, false
	}
	return &req, jid, true
}

func (s *session) send(w http.ResponseWriter, r *http.Request) {
	req, jid, ok := readReq(w, r)
	if !ok {
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		fail(w, http.StatusBadRequest, errors.New("text is empty"))
		return
	}
	cli := s.loggedIn(w)
	if cli == nil {
		return
	}
	resp, err := cli.SendMessage(r.Context(), jid, &waE2E.Message{Conversation: proto.String(req.Text)})
	if err != nil {
		fail(w, http.StatusBadGateway, err)
		return
	}
	s.goOnline(r.Context(), cli)
	reply(w, http.StatusOK, map[string]any{"id": jid.String() + "/" + resp.ID, "at": resp.Timestamp.UnixMilli()})
}

func (s *session) typing(w http.ResponseWriter, r *http.Request) {
	req, jid, ok := readReq(w, r)
	if !ok {
		return
	}
	cli := s.loggedIn(w)
	if cli == nil {
		return
	}
	state := types.ChatPresencePaused
	if req.On {
		state = types.ChatPresenceComposing
		s.goOnline(r.Context(), cli)
		// their typing is told while online, and only for chats subscribed to
		_ = cli.SubscribePresence(r.Context(), jid)
	}
	if err := cli.SendChatPresence(r.Context(), jid, state, types.ChatPresenceMediaText); err != nil {
		fail(w, http.StatusBadGateway, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *session) logout(w http.ResponseWriter, r *http.Request) {
	cli := s.loggedIn(w)
	if cli == nil {
		return
	}
	if err := cli.Logout(r.Context()); err != nil {
		fail(w, http.StatusBadGateway, err)
		return
	}
	s.b.forget(s.user)
	s.setDevice(s.b.store.NewDevice())
	reply(w, http.StatusOK, map[string]any{"ok": true})
}

// media: a file of a message, fetched from WhatsApp and decrypted, by the details its `files`
// entry carried: written to a temporary file (a video can be large), then streamed back.
func (s *session) media(w http.ResponseWriter, r *http.Request) {
	var f file
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&f); err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	cli := s.client()
	if cli.Store.ID == nil {
		fail(w, http.StatusConflict, fmt.Errorf("not linked"))
		return
	}
	tmp, err := os.CreateTemp("", "media-*")
	if err != nil {
		fail(w, http.StatusInternalServerError, err)
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	err = cli.DownloadMediaWithPathToFile(r.Context(), f.Path, f.EncSHA256, f.SHA256, f.MediaKey, whatsmeow.MediaType(f.MediaType), "", false, tmp)
	if err != nil {
		// gone from WhatsApp's servers (too old) is for good; the rest may pass on a retry
		status := http.StatusBadGateway
		if errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith404) || errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410) {
			status = http.StatusGone
		}
		fail(w, status, err)
		return
	}
	info, err := tmp.Stat()
	if err != nil {
		fail(w, http.StatusInternalServerError, err)
		return
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		fail(w, http.StatusInternalServerError, err)
		return
	}
	if f.Mime != "" {
		w.Header().Set("Content-Type", f.Mime)
	}
	w.Header().Set("Content-Length", fmt.Sprint(info.Size()))
	if _, err := io.Copy(w, tmp); err != nil {
		log.Printf("%s: media: %v", s.user, err)
	}
}

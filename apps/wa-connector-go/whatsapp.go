package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type whatsappGroup struct {
	ID          string
	Title       string
	OwnerJID    string
	Participant int
	ChatType    string
	ExternalID  string
	ParentGroup string
	IsCommunity bool
}

func whatsmeowDatabaseURL(base, schema string) string {
	separator := "?"
	if strings.Contains(base, "?") {
		separator = "&"
	}
	return base + separator + "search_path=" + schema + ",public"
}

func (a *app) newWhatsmeowStore(ctx context.Context) (*sqlstore.Container, error) {
	return sqlstore.New(ctx, "postgres", whatsmeowDatabaseURL(a.cfg.DatabaseURL, a.cfg.SQLSchema), waLog.Noop)
}

func configureHistorySync(cfg config) {
	if store.DeviceProps == nil || store.DeviceProps.HistorySyncConfig == nil {
		return
	}
	days := uint32(maxInt(1, cfg.BackfillDays))
	pageSize := uint32(maxInt(10, cfg.HistoryPageSize))
	store.DeviceProps.HistorySyncConfig.FullSyncDaysLimit = proto.Uint32(days)
	store.DeviceProps.HistorySyncConfig.RecentSyncDaysLimit = proto.Uint32(days)
	store.DeviceProps.HistorySyncConfig.InitialSyncMaxMessagesPerChat = proto.Uint32(pageSize)
	store.DeviceProps.HistorySyncConfig.OnDemandReady = proto.Bool(true)
	store.DeviceProps.HistorySyncConfig.CompleteOnDemandReady = proto.Bool(true)
}

func (a *app) discoverGroups(ctx context.Context, client *whatsmeow.Client) (map[string]bool, error) {
	lease := a.currentLease()
	if lease == nil {
		return nil, nil
	}
	groups, err := client.GetJoinedGroups(ctx)
	if err != nil {
		return nil, err
	}
	found := make(map[string]bool, len(groups))
	for _, info := range groups {
		if info == nil || info.JID.IsEmpty() {
			continue
		}
		group := whatsappGroup{
			ID:          info.JID.String(),
			Title:       strings.TrimSpace(info.Name),
			OwnerJID:    info.OwnerJID.String(),
			Participant: len(info.Participants),
			ChatType:    "group",
			ExternalID:  info.JID.String(),
			IsCommunity: info.IsParent,
		}
		if group.Title == "" {
			group.Title = group.ID
		}
		if !info.LinkedParentJID.IsEmpty() {
			group.ParentGroup = info.LinkedParentJID.String()
		}
		found[group.ID] = true
		if err := a.upsertWhatsAppGroup(ctx, group); err != nil {
			return found, err
		}
		if info.IsParent {
			if err := a.discoverSubGroups(ctx, client, info.JID, group.ID, found); err != nil {
				log.Printf("whatsapp subgroup discovery failed parent=%s error=%v", group.ID, err)
			}
		}
	}
	return found, a.removeDepartedGroups(ctx, found)
}

func (a *app) discoverSubGroups(ctx context.Context, client *whatsmeow.Client, parent types.JID, parentID string, found map[string]bool) error {
	lease := a.currentLease()
	if lease == nil {
		return nil
	}
	subgroups, err := client.GetSubGroups(ctx, parent)
	if err != nil {
		return err
	}
	for _, target := range subgroups {
		if target == nil || target.JID.IsEmpty() {
			continue
		}
		id := target.JID.String()
		title := strings.TrimSpace(target.Name)
		if title == "" {
			title = id
		}
		found[id] = true
		if err := a.upsertWhatsAppGroup(ctx, whatsappGroup{ID: id, Title: title, OwnerJID: parent.String(), Participant: 0, ChatType: "subgroup", ExternalID: id, ParentGroup: parentID}); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) upsertWhatsAppGroup(ctx context.Context, group whatsappGroup) error {
	lease := a.currentLease()
	if lease == nil {
		return nil
	}
	_, err := a.db.Exec(ctx, `INSERT INTO wa_groups (id,subject,owner_jid,participant_count,is_selected,platform,chat_type,external_chat_id,parent_group_id,owner_user_id)
VALUES ($1,$2,$3,$4,FALSE,'whatsapp',$5,$6,NULLIF($7,''),$8)
ON CONFLICT (id) DO UPDATE SET subject=EXCLUDED.subject,owner_jid=EXCLUDED.owner_jid,participant_count=EXCLUDED.participant_count,platform='whatsapp',chat_type=EXCLUDED.chat_type,external_chat_id=EXCLUDED.external_chat_id,parent_group_id=EXCLUDED.parent_group_id,owner_user_id=EXCLUDED.owner_user_id,updated_at=NOW()`, group.ID, group.Title, nullIfEmpty(group.OwnerJID), group.Participant, group.ChatType, group.ExternalID, group.ParentGroup, lease.account.UserID)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(ctx, `INSERT INTO user_group_access (user_id,group_id,can_read,can_manage,is_selected)
VALUES ($1::uuid,$2,TRUE,TRUE,FALSE) ON CONFLICT (user_id,group_id) DO NOTHING`, lease.account.UserID, group.ID)
	if err != nil {
		return err
	}
	var selected bool
	if err = a.db.QueryRow(ctx, `SELECT COALESCE(is_selected,FALSE) FROM user_group_access WHERE user_id=$1::uuid AND group_id=$2`, lease.account.UserID, group.ID).Scan(&selected); err != nil {
		return err
	}
	return a.publish(subjectGroupDiscovered, "wa.groups.discovered", map[string]any{
		"groupId": group.ID, "subject": group.Title, "ownerJid": group.OwnerJID,
		"participantCount": group.Participant, "isSelected": selected, "platform": whatsappConnector,
		"chatType": group.ChatType, "parentGroupId": nullIfEmpty(group.ParentGroup),
	})
}

func (a *app) removeDepartedGroups(ctx context.Context, found map[string]bool) error {
	lease := a.currentLease()
	if lease == nil {
		return nil
	}
	rows, err := a.db.Query(ctx, `SELECT g.id FROM wa_groups g JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$1::uuid WHERE g.platform='whatsapp'`, lease.account.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var removed []string
	for rows.Next() {
		var groupID string
		if rows.Scan(&groupID) == nil && !found[groupID] {
			removed = append(removed, groupID)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(removed) == 0 {
		return nil
	}
	_, _ = a.db.Exec(ctx, "DELETE FROM user_group_access WHERE user_id=$1::uuid AND group_id=ANY($2::text[])", lease.account.UserID, removed)
	a.cleanupGroups(ctx, removed)
	return nil
}

func (a *app) selectedGroups(ctx context.Context) ([]string, error) {
	lease := a.currentLease()
	if lease == nil {
		return nil, nil
	}
	rows, err := a.db.Query(ctx, `SELECT g.id FROM wa_groups g JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$1::uuid WHERE g.platform='whatsapp' AND uga.is_selected=TRUE ORDER BY g.subject`, lease.account.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			result = append(result, id)
		}
	}
	return result, rows.Err()
}

func (a *app) handleWhatsAppEvent(ctx context.Context, client *whatsmeow.Client, selected map[string]bool, evt any, connected chan<- struct{}) {
	switch value := evt.(type) {
	case *events.Connected:
		select {
		case connected <- struct{}{}:
		default:
		}
	case *events.PairSuccess:
		if lease := a.currentLease(); lease != nil {
			_ = lease.markSession(ctx, value.ID)
			_ = lease.updateQR(ctx, "connected", "", nil, nil)
		}
	case *events.QR:
		lease := a.currentLease()
		if lease == nil || len(value.Codes) == 0 {
			return
		}
		expires := time.Now().Add(60 * time.Second)
		_ = lease.updateQR(ctx, "qr", value.Codes[0], &expires, nil)
		// The QR payload is deliberately persisted only in PostgreSQL. It is not
		// logged, because Docker logs are often retained outside the host.
	case *events.HistorySync:
		a.handleHistorySync(ctx, client, selected, value.Data)
	case *events.Message:
		if value.Info.Chat.IsEmpty() || !selected[value.Info.Chat.String()] {
			return
		}
		if err := a.persistMessage(ctx, client, value); err != nil {
			log.Printf("whatsapp message persistence failed id=%s error=%v", value.Info.ID, err)
		}
	case *events.LoggedOut:
		a.setStatus(ctx, "reauth_required", "WhatsApp-Sitzung wurde auf dem Hauptgerät abgemeldet", errors.New("WHATSAPP_REAUTH_REQUIRED"))
	case *events.StreamReplaced:
		a.setStatus(ctx, "degraded", "WhatsApp-Sitzung wurde durch ein anderes Gerät ersetzt", errors.New("WHATSAPP_STREAM_REPLACED"))
	case *events.Disconnected:
		log.Printf("whatsapp session disconnected")
	}
}

func (a *app) handleHistorySync(ctx context.Context, client *whatsmeow.Client, selected map[string]bool, history *waHistorySync.HistorySync) {
	if history == nil {
		return
	}
	matchedConversations := 0
	persistedMessages := 0
	for _, conversation := range history.GetConversations() {
		if conversation == nil || !selected[conversation.GetID()] {
			continue
		}
		matchedConversations++
		chat, err := types.ParseJID(conversation.GetID())
		if err != nil {
			continue
		}
		for _, historyMessage := range conversation.GetMessages() {
			if historyMessage == nil || historyMessage.GetMessage() == nil {
				continue
			}
			event, parseErr := client.ParseWebMessage(chat, historyMessage.GetMessage())
			if parseErr != nil {
				log.Printf("whatsapp history message parse failed chat=%s error=%v", chat, parseErr)
				continue
			}
			if !event.Info.Timestamp.IsZero() && event.Info.Timestamp.Before(time.Now().Add(-time.Duration(a.cfg.BackfillDays)*24*time.Hour)) {
				continue
			}
			if err := a.persistMessage(ctx, client, event); err != nil {
				log.Printf("whatsapp history persistence failed chat=%s id=%s error=%v", chat, event.Info.ID, err)
			} else {
				persistedMessages++
			}
			if a.cfg.BackfillThrottle > 0 {
				time.Sleep(a.cfg.BackfillThrottle)
			}
		}
		if a.cfg.BackfillGroupDelay > 0 {
			time.Sleep(a.cfg.BackfillGroupDelay)
		}
	}
	log.Printf("whatsapp history sync received type=%s conversations=%d selected=%d persisted=%d", history.GetSyncType().String(), len(history.GetConversations()), matchedConversations, persistedMessages)
}

func extractWhatsAppMessage(message *waE2E.Message) (kind, text, mime, fileName string, media whatsmeow.DownloadableMessage, hasMedia bool, replyID string) {
	if message == nil {
		return "unknown", "", "", "", nil, false, ""
	}
	text = strings.TrimSpace(message.GetConversation())
	if extended := message.GetExtendedTextMessage(); extended != nil {
		text = strings.TrimSpace(extended.GetText())
		if contextInfo := extended.GetContextInfo(); contextInfo != nil {
			replyID = contextInfo.GetStanzaID()
		}
		return "text", text, "", "", nil, false, replyID
	}
	if image := message.GetImageMessage(); image != nil {
		if text == "" {
			text = strings.TrimSpace(image.GetCaption())
		}
		return "image", text, image.GetMimetype(), "", image, true, image.GetContextInfo().GetStanzaID()
	}
	if video := message.GetVideoMessage(); video != nil {
		if text == "" {
			text = strings.TrimSpace(video.GetCaption())
		}
		return "video", text, video.GetMimetype(), "", video, true, video.GetContextInfo().GetStanzaID()
	}
	if audio := message.GetAudioMessage(); audio != nil {
		return "audio", text, audio.GetMimetype(), "", audio, true, audio.GetContextInfo().GetStanzaID()
	}
	if document := message.GetDocumentMessage(); document != nil {
		if text == "" {
			text = strings.TrimSpace(document.GetCaption())
		}
		return "document", text, document.GetMimetype(), document.GetFileName(), document, true, document.GetContextInfo().GetStanzaID()
	}
	if location := message.GetLocationMessage(); location != nil {
		text = strings.TrimSpace(location.GetName())
		if text == "" {
			text = fmt.Sprintf("Ort: %.6f, %.6f", location.GetDegreesLatitude(), location.GetDegreesLongitude())
		}
		return "location", text, "", "", nil, false, location.GetContextInfo().GetStanzaID()
	}
	return "text", text, "", "", nil, false, ""
}

func (a *app) persistMessage(ctx context.Context, client *whatsmeow.Client, event *events.Message) error {
	lease := a.currentLease()
	if lease == nil || event == nil || event.Message == nil || event.Info.Chat.IsEmpty() {
		return nil
	}
	groupID := event.Info.Chat.String()
	kind, text, mime, fileName, downloadable, hasMedia, replyID := extractWhatsAppMessage(event.Message)
	if replyID == "" {
		replyID = string(event.Info.MsgMetaInfo.ThreadMessageID)
	}
	if text == "" && hasMedia {
		text = "[" + kind + "]"
	}
	receivedAt := event.Info.Timestamp
	if receivedAt.IsZero() {
		receivedAt = time.Now()
	}
	raw, err := protojson.Marshal(rawMessageOrMessage(event))
	if err != nil {
		raw = []byte(`{}`)
	}
	contentHash := whatsappMessageContentHash(
		groupID,
		string(event.Info.ID),
		kind,
		text,
		event.Info.Sender.String(),
		mime,
		replyID,
	)
	var sequence int64
	if !receivedAt.IsZero() {
		sequence = receivedAt.UnixMilli()
	}
	var existingID, existingHash, existingMediaStatus *string
	_ = a.db.QueryRow(ctx, "SELECT id::text,content_hash,media_status FROM messages WHERE group_id=$1 AND wa_message_id=$2", groupID, string(event.Info.ID)).Scan(&existingID, &existingHash, &existingMediaStatus)
	if existingHash != nil && *existingHash == contentHash && (!hasMedia || existingMediaStatus != nil && *existingMediaStatus == "completed") {
		// The connector may see the same message through several user leases.
		// Once its content and media are complete, do not download, publish or
		// analyze it again.
		return lease.saveCursor(ctx, groupID, string(event.Info.ID), receivedAt, int(sequence))
	}
	var editedAt *time.Time
	if event.IsEdit {
		editedAt = &receivedAt
	}
	var messageID string
	messageChanged := true
	err = a.db.QueryRow(ctx, `INSERT INTO messages (group_id,wa_message_id,platform,external_chat_id,sender_jid,sender_name,kind,text,received_at,has_media,media_key,media_mime,raw,content_hash,sequence_no,media_status,edited_at)
VALUES ($1,$2,'whatsapp',$1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $8::boolean THEN 'processing' ELSE 'none' END,$14)
ON CONFLICT (group_id,wa_message_id) DO UPDATE SET text=EXCLUDED.text,sender_name=EXCLUDED.sender_name,kind=EXCLUDED.kind,has_media=EXCLUDED.has_media,media_mime=EXCLUDED.media_mime,raw=EXCLUDED.raw,content_hash=EXCLUDED.content_hash,sequence_no=GREATEST(COALESCE(messages.sequence_no,0),COALESCE(EXCLUDED.sequence_no,0)),edited_at=COALESCE(EXCLUDED.edited_at,messages.edited_at)
WHERE messages.content_hash IS DISTINCT FROM EXCLUDED.content_hash
RETURNING id::text`, groupID, string(event.Info.ID), event.Info.Sender.String(), nullIfEmpty(event.Info.PushName), kind, text, receivedAt, hasMedia, nullIfEmpty(string(event.Info.ID)), nullIfEmpty(mime), raw, contentHash, sequence, editedAt).Scan(&messageID)
	if errors.Is(err, pgx.ErrNoRows) {
		messageChanged = false
		err = a.db.QueryRow(ctx, "SELECT id::text FROM messages WHERE group_id=$1 AND wa_message_id=$2", groupID, string(event.Info.ID)).Scan(&messageID)
	}
	if err != nil {
		return err
	}
	if err := lease.saveCursor(ctx, groupID, string(event.Info.ID), receivedAt, int(sequence)); err != nil {
		return err
	}
	mediaKey := fmt.Sprintf("%s/%s", groupID, event.Info.ID)
	objectPath := ""
	if hasMedia && downloadable != nil {
		objectPath, err = a.downloadMedia(ctx, client, downloadable, mediaKey, mime, fileName)
		if err != nil {
			log.Printf("whatsapp media download failed group=%s message=%s error=%v", groupID, event.Info.ID, err)
		}
	}
	if hasMedia {
		_, _ = a.db.Exec(ctx, `UPDATE messages SET media_key=$2,media_mime=$3,media_status=$4 WHERE id=$1::uuid`, messageID, mediaKey, nullIfEmpty(mime), map[bool]string{true: "completed", false: "failed"}[objectPath != ""])
	}
	data := map[string]any{
		"messageId": messageID, "waMessageId": string(event.Info.ID), "groupId": groupID,
		"platform": whatsappConnector, "chatType": "group", "externalChatId": groupID,
		"senderJid": event.Info.Sender.String(), "senderName": nullIfEmpty(event.Info.PushName), "kind": kind,
		"text": text, "receivedAt": receivedAt.UTC().Format(time.RFC3339Nano), "hasMedia": hasMedia,
		"mediaKey": nullIfEmpty(mediaKey), "mediaMime": nullIfEmpty(mime), "replyToWaMessageId": nullIfEmpty(replyID),
		"raw": json.RawMessage(raw), "contentHash": contentHash, "changeType": map[bool]string{true: "updated", false: "created"}[event.IsEdit], "editedAt": map[bool]any{true: receivedAt.UTC().Format(time.RFC3339Nano), false: nil}[event.IsEdit], "sequenceNo": sequence, "mediaObjectPath": nullIfEmpty(objectPath), "fileName": nullIfEmpty(fileName),
	}
	if messageChanged {
		if err := a.publishWithID(subjectMessageReceived, "wa.messages.received", whatsappMessageEventID(contentHash), data); err != nil {
			return err
		}
	}
	mediaNeedsPublish := existingID == nil || existingMediaStatus == nil || *existingMediaStatus != "completed"
	if hasMedia && objectPath != "" && mediaNeedsPublish {
		if err := a.publish(subjectMediaRequested, "media.objects.requested", map[string]any{"messageId": messageID, "mediaKey": mediaKey, "mediaMime": mime, "objectPath": objectPath, "fileName": fileName}); err != nil {
			return err
		}
		if kind == "audio" {
			var jobID string
			if err := a.db.QueryRow(ctx, `INSERT INTO audio_jobs (message_id,media_key,media_mime,status,object_path)
VALUES ($1::uuid,$2,$3,'queued',$4)
ON CONFLICT (message_id,media_key) DO UPDATE SET
  media_mime=COALESCE(audio_jobs.media_mime,EXCLUDED.media_mime),
  object_path=COALESCE(audio_jobs.object_path,EXCLUDED.object_path),
  updated_at=NOW()
RETURNING id::text`, messageID, mediaKey, mime, objectPath).Scan(&jobID); err == nil {
				_ = a.publish(subjectAudioRequested, "media.audio.requested", map[string]any{"jobId": jobID, "messageId": messageID, "mediaKey": mediaKey, "mediaMime": mime, "objectPath": objectPath})
			}
		}
	}
	return nil
}

func whatsappMessageContentHash(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = fmt.Fprintf(hash, "%d:", len(part))
		_, _ = hash.Write([]byte(part))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func whatsappMessageEventID(contentHash string) string {
	return "message:whatsapp:" + contentHash
}

func (a *app) downloadMedia(ctx context.Context, client *whatsmeow.Client, media whatsmeow.DownloadableMessage, mediaKey, mime, fileName string) (string, error) {
	if client == nil || media == nil {
		return "", nil
	}
	var data []byte
	var err error
	for attempt := 1; attempt <= a.cfg.MediaDownloadAttempts; attempt++ {
		data, err = client.Download(ctx, media)
		if err == nil {
			break
		}
		if attempt < a.cfg.MediaDownloadAttempts && a.cfg.MediaRetryInterval > 0 {
			timer := time.NewTimer(a.cfg.MediaRetryInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return "", ctx.Err()
			case <-timer.C:
			}
		}
	}
	if err != nil {
		return "", fmt.Errorf("download attempts exhausted: %w", err)
	}
	ext := filepath.Ext(fileName)
	if ext == "" {
		ext = extensionForMIME(mime)
	}
	name := strings.NewReplacer("/", "_", "\\", "_", ":", "_").Replace(mediaKey) + ext
	if err := os.MkdirAll(a.cfg.MediaDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(a.cfg.MediaDir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func extensionForMIME(mime string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0])) {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "video/mp4":
		return ".mp4"
	case "audio/ogg":
		return ".ogg"
	case "audio/mpeg":
		return ".mp3"
	case "application/pdf":
		return ".pdf"
	default:
		return ".bin"
	}
}

func (a *app) requestHistory(ctx context.Context, client *whatsmeow.Client, groupIDs []string) {
	lease := a.currentLease()
	if lease == nil {
		return
	}
	cutoff := time.Now().Add(-time.Duration(a.cfg.BackfillDays) * 24 * time.Hour)
	for _, groupID := range groupIDs {
		var externalID, sender string
		var receivedAt time.Time
		err := a.db.QueryRow(ctx, `SELECT wa_message_id,received_at,COALESCE(sender_jid,'')
			FROM messages WHERE group_id=$1 ORDER BY received_at ASC LIMIT 1`, groupID).Scan(&externalID, &receivedAt, &sender)
		if errors.Is(err, pgx.ErrNoRows) {
			chat, parseErr := types.ParseJID(groupID)
			if parseErr != nil {
				log.Printf("whatsapp initial history request skipped group=%s error=%v", groupID, parseErr)
				continue
			}
			info := &types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, IsGroup: true}, ID: types.MessageID(""), Timestamp: time.Now()}
			if _, requestErr := client.SendPeerMessage(ctx, client.BuildHistorySyncRequest(info, a.cfg.HistoryPageSize)); requestErr != nil {
				log.Printf("whatsapp initial history request failed group=%s days=%d error=%v", groupID, a.cfg.BackfillDays, requestErr)
			} else {
				log.Printf("whatsapp initial history request sent group=%s days=%d page_size=%d", groupID, a.cfg.BackfillDays, a.cfg.HistoryPageSize)
			}
			if a.cfg.HistoryRequestDelay > 0 {
				time.Sleep(a.cfg.HistoryRequestDelay)
			}
			continue
		}
		if err != nil {
			continue
		}
		if !receivedAt.After(cutoff) {
			log.Printf("whatsapp history backfill complete group=%s oldest=%s cutoff=%s", groupID, receivedAt.UTC().Format(time.RFC3339), cutoff.UTC().Format(time.RFC3339))
			continue
		}
		chat, err := types.ParseJID(groupID)
		if err != nil {
			continue
		}
		senderJID, _ := types.ParseJID(sender)
		info := &types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: senderJID, IsGroup: true}, ID: types.MessageID(externalID), Timestamp: receivedAt}
		if _, err := client.SendPeerMessage(ctx, client.BuildHistorySyncRequest(info, a.cfg.HistoryPageSize)); err != nil {
			log.Printf("whatsapp history request failed group=%s oldest=%s error=%v", groupID, externalID, err)
		} else {
			log.Printf("whatsapp history request sent group=%s before=%s page_size=%d", groupID, externalID, a.cfg.HistoryPageSize)
		}
		if a.cfg.HistoryRequestDelay > 0 {
			time.Sleep(a.cfg.HistoryRequestDelay)
		}
	}
}

// rawMessageOrMessage makes the raw payload safe for both live and history
// events. It also keeps this connector compatible with older event wrappers.
func rawMessageOrMessage(evt *events.Message) *waE2E.Message {
	if evt == nil {
		return nil
	}
	if evt.RawMessage != nil {
		return evt.RawMessage
	}
	return evt.Message
}

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
	"strconv"
	"strings"
	"time"

	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/tg"
	"github.com/jackc/pgx/v5"
)

type telegramEntity struct {
	GroupID           string
	Title             string
	ChatType          string
	ExternalID        string
	ParticipantCount  int
	Input             tg.InputPeerClass
	Channel           *tg.Channel
	TopicID           int
	TopicTopMessageID int
}

type telegramMedia struct {
	Key      string
	Mime     string
	FileName string
	Location tg.InputFileLocationClass
}

func normalizedTelegramID(id int64) string { return "tg:" + strconv.FormatInt(id, 10) }

func (a *app) putEntity(entity *telegramEntity) {
	a.entitiesMu.Lock()
	if a.entities == nil {
		a.entities = map[string]*telegramEntity{}
	}
	a.entities[entity.GroupID] = entity
	a.entitiesMu.Unlock()
}

func (a *app) getEntity(groupID string) *telegramEntity {
	a.entitiesMu.RLock()
	defer a.entitiesMu.RUnlock()
	return a.entities[groupID]
}

func dialogPeer(peer tg.PeerClass) (int64, string, bool) {
	switch p := peer.(type) {
	case *tg.PeerChat:
		return p.ChatID, "chat", true
	case *tg.PeerChannel:
		return p.ChannelID, "channel", true
	default:
		return 0, "", false
	}
}

func dialogData(value tg.MessagesDialogsClass) (dialogs []tg.DialogClass, chats []tg.ChatClass) {
	switch data := value.(type) {
	case *tg.MessagesDialogs:
		return data.Dialogs, data.Chats
	case *tg.MessagesDialogsSlice:
		return data.Dialogs, data.Chats
	default:
		return nil, nil
	}
}

func (a *app) upsertTelegramGroup(ctx context.Context, entity *telegramEntity) (bool, error) {
	lease := a.currentLease()
	if lease == nil {
		return false, nil
	}
	_, err := a.db.Exec(ctx, `INSERT INTO wa_groups (id,subject,owner_jid,participant_count,is_selected,platform,chat_type,external_chat_id,owner_user_id)
VALUES ($1,$2,$3,$4,FALSE,'telegram',$5,$1,$6)
ON CONFLICT (id) DO UPDATE SET subject=EXCLUDED.subject,owner_jid=EXCLUDED.owner_jid,participant_count=EXCLUDED.participant_count,platform='telegram',chat_type=EXCLUDED.chat_type,external_chat_id=EXCLUDED.external_chat_id,updated_at=NOW()`, entity.GroupID, entity.Title, "tg:direct:"+entity.ExternalID, entity.ParticipantCount, entity.ChatType, lease.account.UserID)
	if err != nil {
		return false, err
	}
	_, err = a.db.Exec(ctx, `INSERT INTO user_group_access (user_id,group_id,can_read,can_manage,is_selected)
VALUES ($1::uuid,$2,TRUE,TRUE,FALSE) ON CONFLICT (user_id,group_id) DO NOTHING`, lease.account.UserID, entity.GroupID)
	if err != nil {
		return false, err
	}
	var selected bool
	if err = a.db.QueryRow(ctx, `SELECT COALESCE(uga.is_selected,FALSE)
FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`, entity.GroupID, lease.account.UserID).Scan(&selected); err != nil {
		return false, err
	}
	_ = a.publish(subjectGroupDiscovered, "wa.groups.discovered", map[string]any{
		"groupId": entity.GroupID, "subject": entity.Title, "ownerJid": "tg:direct:" + entity.ExternalID,
		"participantCount": entity.ParticipantCount, "isSelected": selected, "platform": "telegram", "chatType": entity.ChatType,
	})
	return selected, nil
}

func (a *app) discoverTopics(ctx context.Context, parent *telegramEntity, found map[string]bool) error {
	if parent.Channel == nil || !parent.Channel.Forum {
		return nil
	}
	result, err := a.client.API().MessagesGetForumTopics(ctx, &tg.MessagesGetForumTopicsRequest{Peer: parent.Input, Limit: 100})
	if err != nil {
		return err
	}
	for _, rawTopic := range result.Topics {
		topic, ok := rawTopic.(*tg.ForumTopic)
		if !ok || topic.ID == 0 {
			continue
		}
		groupID := fmt.Sprintf("%s:topic:%d", parent.GroupID, topic.ID)
		entity := &telegramEntity{GroupID: groupID, Title: parent.Title + " · " + strings.TrimSpace(topic.Title), ChatType: "topic", ExternalID: parent.ExternalID, ParticipantCount: parent.ParticipantCount, Input: parent.Input, Channel: parent.Channel, TopicID: topic.ID, TopicTopMessageID: topic.TopMessage}
		// Topics are separate selectable sources. They must be part of the
		// current dialog snapshot as well, otherwise removeDepartedGroups would
		// delete their user access immediately after discovery.
		found[groupID] = true
		a.putEntity(entity)
		if err := a.upsertTelegramTopic(ctx, entity, parent.GroupID, topic.ID, topic.TopMessage); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) upsertTelegramTopic(ctx context.Context, entity *telegramEntity, parentID string, topicID, rootMessageID int) error {
	lease := a.currentLease()
	if lease == nil {
		return nil
	}
	_, err := a.db.Exec(ctx, `INSERT INTO wa_groups (id,subject,owner_jid,participant_count,is_selected,platform,chat_type,external_chat_id,parent_group_id,topic_id,topic_root_message_id,owner_user_id)
VALUES ($1,$2,$3,$4,FALSE,'telegram','topic',$5,$6,$7,$8,$9)
ON CONFLICT (id) DO UPDATE SET subject=EXCLUDED.subject,participant_count=EXCLUDED.participant_count,chat_type='topic',external_chat_id=EXCLUDED.external_chat_id,parent_group_id=EXCLUDED.parent_group_id,topic_id=EXCLUDED.topic_id,topic_root_message_id=EXCLUDED.topic_root_message_id,updated_at=NOW()`, entity.GroupID, entity.Title, "tg:direct:"+entity.ExternalID, entity.ParticipantCount, entity.ExternalID, parentID, topicID, rootMessageID, lease.account.UserID)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(ctx, `INSERT INTO user_group_access (user_id,group_id,can_read,can_manage,is_selected) VALUES ($1::uuid,$2,TRUE,TRUE,FALSE) ON CONFLICT (user_id,group_id) DO NOTHING`, lease.account.UserID, entity.GroupID)
	if err != nil {
		return err
	}
	var selected bool
	_ = a.db.QueryRow(ctx, `SELECT COALESCE(uga.is_selected,FALSE) FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`, entity.GroupID, lease.account.UserID).Scan(&selected)
	return a.publish(subjectGroupDiscovered, "wa.groups.discovered", map[string]any{"groupId": entity.GroupID, "subject": entity.Title, "ownerJid": "tg:direct:" + entity.ExternalID, "isSelected": selected, "platform": "telegram", "chatType": "topic", "parentGroupId": parentID, "topicId": strconv.Itoa(topicID)})
}

func (a *app) discoverDialogs(ctx context.Context) error {
	// Telegram's TL schema requires offset_peer even for the first page. The
	// zero value is nil and gotd cannot encode it, which otherwise results in
	// "field offset_peer is nil" before the request reaches Telegram.
	result, err := a.client.API().MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{
		OffsetPeer: &tg.InputPeerEmpty{},
		Limit:      1000,
	})
	if err != nil {
		return err
	}
	dialogs, chats := dialogData(result)
	log.Printf("telegram dialog refresh received dialogs=%d chats=%d", len(dialogs), len(chats))
	chatByID := map[int64]*tg.Chat{}
	channelByID := map[int64]*tg.Channel{}
	for _, rawChat := range chats {
		switch chat := rawChat.(type) {
		case *tg.Chat:
			chatByID[chat.ID] = chat
		case *tg.Channel:
			channelByID[chat.ID] = chat
		}
	}
	found := map[string]bool{}
	for _, dialog := range dialogs {
		dialogValue, ok := dialog.(*tg.Dialog)
		if !ok {
			continue
		}
		id, kind, ok := dialogPeer(dialogValue.Peer)
		if !ok {
			continue
		}
		var entity *telegramEntity
		if kind == "chat" {
			chat := chatByID[id]
			if chat == nil || chat.Left || chat.Deactivated {
				continue
			}
			entity = &telegramEntity{GroupID: normalizedTelegramID(id), Title: chat.Title, ChatType: "group", ExternalID: strconv.FormatInt(id, 10), ParticipantCount: chat.ParticipantsCount, Input: chat.AsInputPeer()}
		} else {
			channel := channelByID[id]
			if channel == nil || channel.Left {
				continue
			}
			chatType := "channel"
			if channel.Megagroup {
				chatType = "supergroup"
			}
			entity = &telegramEntity{GroupID: normalizedTelegramID(id), Title: channel.Title, ChatType: chatType, ExternalID: strconv.FormatInt(id, 10), ParticipantCount: channel.ParticipantsCount, Input: channel.AsInputPeer(), Channel: channel}
		}
		if entity.Title == "" {
			entity.Title = entity.GroupID
		}
		found[entity.GroupID] = true
		a.putEntity(entity)
		if _, err := a.upsertTelegramGroup(ctx, entity); err != nil {
			return err
		}
		if entity.Channel != nil && entity.Channel.Forum {
			if err := a.discoverTopics(ctx, entity, found); err != nil {
				// Some channels expose a forum flag but reject forum discovery for a
				// restricted account. The parent group remains usable and existing
				// topics must not be treated as departed because of this transient
				// refresh failure.
				fmt.Printf("Telegram forum topic discovery failed for %s: %v\n", entity.GroupID, err)
				a.preserveExistingTopics(ctx, entity, found)
			}
		}
	}
	return a.removeDepartedGroups(ctx, found)
}

func (a *app) preserveExistingTopics(ctx context.Context, parent *telegramEntity, found map[string]bool) {
	lease := a.currentLease()
	if lease == nil {
		return
	}
	rows, err := a.db.Query(ctx, `SELECT g.id FROM wa_groups g
JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$1::uuid
WHERE g.platform='telegram' AND g.parent_group_id=$2`, lease.account.UserID, parent.GroupID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var groupID string
		if rows.Scan(&groupID) == nil {
			found[groupID] = true
		}
	}
}

func (a *app) removeDepartedGroups(ctx context.Context, found map[string]bool) error {
	lease := a.currentLease()
	if lease == nil {
		return nil
	}
	rows, err := a.db.Query(ctx, `SELECT g.id FROM wa_groups g JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$1::uuid WHERE g.platform='telegram'`, lease.account.UserID)
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
	rows, err := a.db.Query(ctx, `SELECT g.id FROM wa_groups g JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$1::uuid WHERE g.platform='telegram' AND uga.is_selected=TRUE ORDER BY g.subject`, lease.account.UserID)
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

func forumTopicID(message *tg.Message) int {
	reply, ok := message.GetReplyTo()
	if !ok {
		return 0
	}
	if header, ok := reply.(*tg.MessageReplyHeader); ok {
		if header.ReplyToTopID != 0 {
			return header.ReplyToTopID
		}
		return header.ReplyToMsgID
	}
	return 0
}

func (a *app) backfillGroup(ctx context.Context, groupID string) error {
	entity := a.getEntity(groupID)
	lease := a.currentLease()
	if entity == nil {
		log.Printf("telegram backfill skipped group=%s reason=entity-not-in-current-dialog-snapshot", groupID)
		return nil
	}
	if lease == nil {
		return nil
	}
	selected, err := a.isSelected(ctx, groupID, lease.account.UserID)
	if err != nil || !selected {
		return err
	}
	cursor, err := lease.loadCursor(ctx, groupID)
	if err != nil {
		return err
	}
	cutoff := time.Now().Add(-time.Duration(a.cfg.BackfillDays) * 24 * time.Hour)
	offsetID := 0
	fetched, recent, topicMatches, persisted := 0, 0, 0, 0
	log.Printf("telegram backfill group=%s title=%q chat_type=%s topic_id=%d topic_top=%d cursor=%d", groupID, entity.Title, entity.ChatType, entity.TopicID, entity.TopicTopMessageID, cursor)
	for page := 0; page < 20; page++ {
		var result tg.MessagesMessagesClass
		var requestErr error
		if entity.TopicID != 0 {
			// For forum topics Telegram uses the topic ID as the root message ID.
			// ForumTopic.TopMessage is only the latest message and is not valid
			// for messages.getReplies (it produces TOPIC_ID_INVALID).
			result, requestErr = a.client.API().MessagesGetReplies(ctx, &tg.MessagesGetRepliesRequest{Peer: entity.Input, MsgID: entity.TopicID, OffsetID: offsetID, Limit: 100, MinID: cursor})
		} else {
			result, requestErr = a.client.API().MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{Peer: entity.Input, OffsetID: offsetID, Limit: 100, MinID: cursor})
		}
		if requestErr != nil {
			return requestErr
		}
		messages, users := historyData(result)
		fetched += len(messages)
		log.Printf("telegram backfill history group=%s page=%d messages=%d offset_id=%d", groupID, page+1, len(messages), offsetID)
		if len(messages) == 0 {
			break
		}
		userNames := map[int64]string{}
		for _, user := range users {
			if u, ok := user.(*tg.User); ok {
				name := strings.TrimSpace(strings.TrimSpace(u.FirstName + " " + u.LastName))
				if name == "" {
					name = u.Username
				}
				userNames[u.ID] = name
			}
		}
		oldest := 0
		var oldestDate time.Time
		for _, rawMessage := range messages {
			message, ok := rawMessage.(*tg.Message)
			if !ok {
				continue
			}
			if oldest == 0 || message.ID < oldest {
				oldest = message.ID
			}
			messageDate := time.Unix(int64(message.Date), 0)
			if oldestDate.IsZero() || messageDate.Before(oldestDate) {
				oldestDate = messageDate
			}
			if messageDate.Before(cutoff) {
				continue
			}
			recent++
			messageTopicID := forumTopicID(message)
			if entity.TopicID != 0 && messageTopicID != entity.TopicID && !(entity.TopicID == 1 && messageTopicID == 0) {
				continue
			}
			topicMatches++
			if err := a.persistMessage(ctx, entity, message, userNames); err != nil {
				return err
			}
			persisted++
			if a.cfg.BackfillThrottle > 0 {
				time.Sleep(a.cfg.BackfillThrottle)
			}
		}
		if oldest == 0 || len(messages) < 100 || oldest <= cursor || !oldestDate.IsZero() && oldestDate.Before(cutoff) {
			break
		}
		offsetID = oldest
		if a.cfg.BackfillGroupDelay > 0 {
			time.Sleep(a.cfg.BackfillGroupDelay)
		}
	}
	log.Printf("telegram backfill finished group=%s fetched=%d recent=%d topic_matches=%d persisted=%d cursor=%d", groupID, fetched, recent, topicMatches, persisted, cursor)
	return nil
}

func historyData(value tg.MessagesMessagesClass) ([]tg.MessageClass, []tg.UserClass) {
	switch data := value.(type) {
	case *tg.MessagesMessages:
		return data.Messages, data.Users
	case *tg.MessagesMessagesSlice:
		return data.Messages, data.Users
	case *tg.MessagesChannelMessages:
		return data.Messages, data.Users
	default:
		return nil, nil
	}
}

func (a *app) isSelected(ctx context.Context, groupID, userID string) (bool, error) {
	var selected bool
	err := a.db.QueryRow(ctx, `SELECT COALESCE(uga.is_selected,FALSE) FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`, groupID, userID).Scan(&selected)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return selected, err
}

func messageSender(message *tg.Message, users map[int64]string, fallback *telegramEntity) (string, string) {
	switch from := message.FromID.(type) {
	case *tg.PeerUser:
		name := users[from.UserID]
		if name == "" {
			name = fmt.Sprintf("Telegram user %d", from.UserID)
		}
		return "tg:user:" + strconv.FormatInt(from.UserID, 10), name
	case *tg.PeerChannel:
		return "tg:chat:" + strconv.FormatInt(from.ChannelID, 10), fallback.Title
	case *tg.PeerChat:
		return "tg:chat:" + strconv.FormatInt(from.ChatID, 10), fallback.Title
	default:
		return "tg:chat:" + fallback.ExternalID, fallback.Title
	}
}

func messageText(message *tg.Message) string {
	if text := message.Message; text != "" {
		return text
	}
	media, ok := message.GetMedia()
	if !ok {
		return ""
	}
	switch value := media.(type) {
	case *tg.MessageMediaGeo:
		if point, ok := value.Geo.(*tg.GeoPoint); ok {
			return fmt.Sprintf("Ort: %.6f, %.6f", point.Lat, point.Long)
		}
	case *tg.MessageMediaVenue:
		if point, ok := value.Geo.(*tg.GeoPoint); ok {
			return fmt.Sprintf("Ort: %.6f, %.6f\n%s", point.Lat, point.Long, value.Title)
		}
	}
	return ""
}

func messageKindAndMedia(message *tg.Message) (string, *telegramMedia) {
	media, hasMedia := message.GetMedia()
	if !hasMedia {
		return "text", nil
	}
	key := func() string {
		return "telegram-direct/" + strconv.FormatInt(peerID(message.PeerID), 10) + "/" + strconv.Itoa(message.ID)
	}
	switch value := media.(type) {
	case *tg.MessageMediaGeo, *tg.MessageMediaVenue:
		return "location", nil
	case *tg.MessageMediaPhoto:
		photo, ok := value.Photo.(*tg.Photo)
		if !ok {
			return "image", nil
		}
		sizeType := "y"
		for _, size := range photo.Sizes {
			if item, ok := size.(*tg.PhotoSize); ok && item.Type != "" {
				sizeType = item.Type
			}
		}
		return "image", &telegramMedia{Key: key(), Mime: "image/jpeg", Location: &tg.InputPhotoFileLocation{ID: photo.ID, AccessHash: photo.AccessHash, FileReference: photo.FileReference, ThumbSize: sizeType}}
	case *tg.MessageMediaDocument:
		document, ok := value.Document.(*tg.Document)
		if !ok {
			return "document", nil
		}
		kind := "document"
		if value.Voice || strings.HasPrefix(document.MimeType, "audio/") {
			kind = "audio"
		} else if value.Video || strings.HasPrefix(document.MimeType, "video/") {
			kind = "video"
		}
		return kind, &telegramMedia{Key: key(), Mime: document.MimeType, Location: &tg.InputDocumentFileLocation{ID: document.ID, AccessHash: document.AccessHash, FileReference: document.FileReference}}
	default:
		return "document", nil
	}
}

func peerID(peer tg.PeerClass) int64 {
	switch value := peer.(type) {
	case *tg.PeerChannel:
		return value.ChannelID
	case *tg.PeerChat:
		return value.ChatID
	case *tg.PeerUser:
		return value.UserID
	default:
		return 0
	}
}

func mediaExtension(kind, mime string) string {
	if kind == "image" {
		return ".jpg"
	}
	if kind == "audio" {
		if strings.Contains(mime, "mpeg") {
			return ".mp3"
		}
		return ".ogg"
	}
	if kind == "video" {
		return ".mp4"
	}
	if strings.Contains(mime, "pdf") {
		return ".pdf"
	}
	return ".bin"
}

func (a *app) downloadMedia(ctx context.Context, media *telegramMedia, kind string) (string, error) {
	if media == nil || a.client == nil {
		return "", nil
	}
	directory := filepath.Join(a.cfg.MediaDir, "incoming")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", err
	}
	name := strings.NewReplacer("/", "_", ":", "_").Replace(media.Key) + mediaExtension(kind, media.Mime)
	path := filepath.Join(directory, name)
	for attempt := 0; attempt < 4; attempt++ {
		if _, err := a.client.Download(media.Location).ToPath(ctx, path); err == nil {
			return path, nil
		} else if attempt == 3 {
			return "", err
		}
		time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
	}
	return "", errors.New("media download exhausted")
}

func (a *app) persistMessage(ctx context.Context, entity *telegramEntity, message *tg.Message, users map[int64]string) error {
	lease := a.currentLease()
	if lease == nil {
		return nil
	}
	selected, err := a.isSelected(ctx, entity.GroupID, lease.account.UserID)
	if err != nil || !selected {
		return err
	}
	kind, media := messageKindAndMedia(message)
	text := messageText(message)
	raw, _ := json.Marshal(message)
	waMessageID := entity.GroupID + ":" + strconv.Itoa(message.ID)
	senderID, senderName := messageSender(message, users, entity)
	replyID := ""
	if reply, ok := message.GetReplyTo(); ok {
		if header, ok := reply.(*tg.MessageReplyHeader); ok && header.ReplyToMsgID != 0 {
			replyID = entity.GroupID + ":" + strconv.Itoa(header.ReplyToMsgID)
		}
	}
	contentHash := telegramMessageContentHash(
		entity.GroupID,
		waMessageID,
		kind,
		text,
		senderID,
		mediaMime(media),
		replyID,
	)
	var existingID, existingHash, existingMediaStatus *string
	_ = a.db.QueryRow(ctx, "SELECT id::text,content_hash,media_status FROM messages WHERE group_id=$1 AND wa_message_id=$2", entity.GroupID, waMessageID).Scan(&existingID, &existingHash, &existingMediaStatus)
	if existingHash != nil && *existingHash == contentHash && (media == nil || existingMediaStatus != nil && *existingMediaStatus == "completed") {
		return nil
	}
	objectPath := ""
	if media != nil {
		if downloaded, downloadErr := a.downloadMedia(ctx, media, kind); downloadErr == nil {
			objectPath = downloaded
		} else {
			fmt.Printf("Telegram media download failed %s: %v\n", media.Key, downloadErr)
		}
	}
	mediaStatus := "none"
	if media != nil {
		mediaStatus = "pending"
		if objectPath != "" {
			mediaStatus = "completed"
		}
	}
	var messageID string
	err = a.db.QueryRow(ctx, `INSERT INTO messages (group_id,wa_message_id,platform,external_chat_id,sender_jid,sender_name,kind,text,received_at,has_media,media_key,media_mime,raw,content_hash,sequence_no,media_status)
VALUES ($1,$2,'telegram',$3,$4,$5,$6,$7,to_timestamp($8),$9,$10,$11,$12,$13,$14,$15)
ON CONFLICT (group_id,wa_message_id) DO UPDATE SET sender_jid=EXCLUDED.sender_jid,sender_name=EXCLUDED.sender_name,kind=EXCLUDED.kind,text=EXCLUDED.text,received_at=EXCLUDED.received_at,has_media=EXCLUDED.has_media,media_key=EXCLUDED.media_key,media_mime=EXCLUDED.media_mime,raw=EXCLUDED.raw,content_hash=EXCLUDED.content_hash,sequence_no=EXCLUDED.sequence_no,media_status=CASE WHEN EXCLUDED.media_status='completed' THEN 'completed' ELSE messages.media_status END
WHERE messages.content_hash IS DISTINCT FROM EXCLUDED.content_hash
RETURNING id::text`, entity.GroupID, waMessageID, entity.ExternalID, senderID, nullIfEmpty(senderName), kind, text, message.Date, media != nil, nullIfMediaKey(media), nullIfMediaMime(media), raw, contentHash, message.ID, mediaStatus).Scan(&messageID)
	messageChanged := true
	if errors.Is(err, pgx.ErrNoRows) {
		messageChanged = false
		err = a.db.QueryRow(ctx, "SELECT id::text FROM messages WHERE group_id=$1 AND wa_message_id=$2", entity.GroupID, waMessageID).Scan(&messageID)
	}
	if err != nil {
		return err
	}
	data := map[string]any{"messageId": messageID, "waMessageId": waMessageID, "groupId": entity.GroupID, "platform": "telegram", "chatType": entity.ChatType, "externalChatId": entity.ExternalID, "senderJid": senderID, "senderName": senderName, "kind": kind, "text": text, "receivedAt": time.Unix(int64(message.Date), 0).UTC().Format(time.RFC3339), "hasMedia": media != nil, "mediaKey": nullIfMediaKey(media), "mediaMime": nullIfMediaMime(media), "replyToWaMessageId": nullIfEmpty(replyID), "raw": json.RawMessage(raw), "contentHash": contentHash, "mediaObjectPath": nullIfEmpty(objectPath), "changeType": ternary(existingID != nil, "updated", "created"), "sequenceNo": message.ID}
	if messageChanged {
		if err := a.publishWithID(subjectMessageReceived, "wa.messages.received", telegramMessageEventID(contentHash), data); err != nil {
			return err
		}
	}
	mediaNeedsPublish := existingID == nil || existingMediaStatus == nil || *existingMediaStatus != "completed"
	if media != nil && objectPath != "" && mediaNeedsPublish {
		_ = a.publish(subjectMediaRequested, "media.objects.requested", map[string]any{"messageId": messageID, "mediaKey": media.Key, "objectPath": objectPath, "mediaMime": media.Mime, "kind": kind, "platform": "telegram", "fileName": media.FileName})
		if kind == "audio" {
			var jobID string
			if err := a.db.QueryRow(ctx, `INSERT INTO audio_jobs (message_id,media_key,media_mime,status,object_path)
VALUES ($1::uuid,$2,$3,'queued',$4)
ON CONFLICT (message_id,media_key) DO UPDATE SET
  media_mime=COALESCE(audio_jobs.media_mime,EXCLUDED.media_mime),
  object_path=COALESCE(audio_jobs.object_path,EXCLUDED.object_path),
  updated_at=NOW()
RETURNING id::text`, messageID, media.Key, media.Mime, objectPath).Scan(&jobID); err == nil {
				_ = a.publish(subjectAudioRequested, "media.audio.requested", map[string]any{"jobId": jobID, "messageId": messageID, "mediaKey": media.Key, "mediaMime": media.Mime, "objectPath": objectPath})
			}
		}
	}
	_ = lease.saveCursor(ctx, entity.GroupID, strconv.Itoa(message.ID), time.Unix(int64(message.Date), 0), message.ID)
	return nil
}

func telegramMessageContentHash(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = fmt.Fprintf(hash, "%d:", len(part))
		_, _ = hash.Write([]byte(part))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func telegramMessageEventID(contentHash string) string {
	return "message:telegram:" + contentHash
}

func mediaMime(media *telegramMedia) string {
	if media == nil {
		return ""
	}
	return media.Mime
}

func nullIfMediaKey(value *telegramMedia) any {
	if value == nil {
		return nil
	}
	return value.Key
}

func nullIfMediaMime(value *telegramMedia) any {
	if value == nil || value.Mime == "" {
		return nil
	}
	return value.Mime
}

func ternary(condition bool, yes, no string) string {
	if condition {
		return yes
	}
	return no
}

func (a *app) handleUpdate(ctx context.Context, entities tg.Entities, raw tg.MessageClass) error {
	message, ok := raw.(*tg.Message)
	if !ok {
		return nil
	}
	peer := peerID(message.PeerID)
	groupID := normalizedTelegramID(peer)
	a.entitiesMu.RLock()
	entity := a.entities[groupID]
	a.entitiesMu.RUnlock()
	if entity == nil {
		return nil
	}
	users := map[int64]string{}
	for id, user := range entities.Users {
		name := strings.TrimSpace(strings.TrimSpace(user.FirstName + " " + user.LastName))
		if name == "" {
			name = user.Username
		}
		users[id] = name
	}
	messageEntities := []*telegramEntity{entity}
	if entity.Channel != nil && entity.Channel.Forum {
		topicID := forumTopicID(message)
		if topicID == 0 {
			// Telegram's General forum topic intentionally has no forum-topic
			// marker in messageReplyHeader. It is represented by topic 1.
			topicID = 1
		}
		if topic := a.getEntity(fmt.Sprintf("%s:topic:%d", entity.GroupID, topicID)); topic != nil {
			messageEntities = append(messageEntities, topic)
		}
	}
	for _, target := range messageEntities {
		if err := a.persistMessage(ctx, target, message, users); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) runTelegramCycle(parent context.Context, onboarding *onboardingInfo) error {
	lease := a.currentLease()
	if lease == nil {
		return errors.New("telegram cycle without account lease")
	}
	cycleCtx, cancel := context.WithCancel(parent)
	a.setCycleCancel(cancel)
	defer func() {
		cancel()
		a.setCycleCancel(nil)
	}()
	dispatcher := tg.NewUpdateDispatcher()
	dispatcher.OnNewMessage(func(ctx context.Context, entities tg.Entities, update *tg.UpdateNewMessage) error {
		return a.handleUpdate(ctx, entities, update.Message)
	})
	dispatcher.OnNewChannelMessage(func(ctx context.Context, entities tg.Entities, update *tg.UpdateNewChannelMessage) error {
		return a.handleUpdate(ctx, entities, update.Message)
	})
	client := telegram.NewClient(a.cfg.APIID, a.cfg.APIHash, telegram.Options{
		Logger:         connectorGotdLogger{},
		SessionStorage: &postgresSession{lease: lease},
		UpdateHandler:  dispatcher,
	})
	a.mu.Lock()
	a.client = client
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.client = nil
		a.mu.Unlock()
	}()
	return client.Run(cycleCtx, func(ctx context.Context) error {
		status, err := client.Auth().Status(ctx)
		if err != nil {
			return err
		}
		if !status.Authorized {
			if onboarding == nil {
				return errors.New("TELEGRAM_REAUTH_REQUIRED: telegram session is not authorized")
			}
			if err := a.runQRAuth(ctx, client, dispatcher, onboarding); err != nil {
				return err
			}
			log.Printf("telegram QR authorization completed account=%s", lease.account.ID)
		} else {
			log.Printf("telegram session restored account=%s", lease.account.ID)
		}
		now := time.Now().UTC()
		a.mu.Lock()
		a.connectedAt = &now
		a.mu.Unlock()
		if err := a.discoverDialogs(ctx); err != nil {
			return err
		}
		if onboarding != nil {
			_ = lease.updateOnboarding(ctx, onboarding.ID, "connected", nil)
			_ = lease.updateQR(ctx, "connected", "", nil, nil)
			_, _ = a.db.Exec(ctx, "UPDATE connector_accounts SET next_sync_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1::uuid", lease.account.ID)
			return nil
		}
		groups, err := a.selectedGroups(ctx)
		if err != nil {
			return err
		}
		a.setStatus(ctx, "syncing", fmt.Sprintf("Backfill der letzten %d Tage für %d ausgewählte Gruppe(n)", a.cfg.BackfillDays, len(groups)), nil)
		log.Printf("telegram processing selected_groups=%d backfill_days=%d account=%s", len(groups), a.cfg.BackfillDays, lease.account.ID)
		for index, groupID := range groups {
			if index > 0 && a.cfg.BackfillGroupDelay > 0 {
				time.Sleep(a.cfg.BackfillGroupDelay)
			}
			if err := a.backfillGroup(ctx, groupID); err != nil {
				log.Printf("telegram backfill failed for %s: %v", groupID, err)
			}
		}
		a.completeInitialBackfill(ctx)
		now = time.Now().UTC()
		a.mu.Lock()
		a.connectedAt = &now
		a.mu.Unlock()
		a.setStatus(ctx, "ready", "Direct Telegram mit gotd/td verbunden; Verarbeitungsschleife abgeschlossen", nil)
		log.Printf("telegram processing cycle completed account=%s groups=%d", lease.account.ID, len(groups))
		return nil
	})
}

func (a *app) runQRAuth(ctx context.Context, client *telegram.Client, dispatcher tg.UpdateDispatcher, onboarding *onboardingInfo) error {
	loggedIn := qrlogin.OnLoginToken(dispatcher)
	a.setStatus(ctx, "pairing", "Telegram-QR mit der mobilen Telegram-App scannen", nil)
	lease := a.currentLease()
	if lease == nil {
		return errors.New("telegram QR login without account lease")
	}
	log.Printf("telegram QR login started account=%s", lease.account.ID)
	_, err := client.QR().Auth(ctx, loggedIn, func(ctx context.Context, token qrlogin.Token) error {
		expires := token.Expires()
		payload := token.URL()
		// The QR payload is persisted for the API/UI only. It is deliberately
		// never logged, avoiding credential leakage through Docker logs.
		lease := a.currentLease()
		if lease == nil {
			return errors.New("telegram QR lease was released")
		}
		return lease.updateQR(ctx, "qr", payload, &expires, nil)
	})
	if err != nil {
		message := err.Error()
		if lease := a.currentLease(); lease != nil {
			_ = lease.updateQR(ctx, "failed", "", nil, &message)
		}
		return err
	}
	if lease := a.currentLease(); lease != nil {
		_ = lease.updateQR(ctx, "connected", "", nil, nil)
		_ = lease.updateOnboarding(ctx, onboarding.ID, "connected", nil)
	}
	return nil
}

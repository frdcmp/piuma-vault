use actix_web::web;

use super::{connect, events, handlers as h, webhooks};

/// A provider's delivery, at most.
const WEBHOOK_BODY: usize = 4 * 1024 * 1024;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    // the Inbox (signed in); fixed sub-paths before the `{id}` ones
    cfg.route("/admin/pigeon/events", web::get().to(events::stream))
        .route("/admin/pigeon/conversations", web::get().to(h::list_conversations))
        .route("/admin/pigeon/conversations/{id}", web::get().to(h::get_conversation))
        .route("/admin/pigeon/conversations/{id}/items", web::get().to(h::conversation_items))
        .route("/admin/pigeon/conversations/{id}/send", web::post().to(h::send))
        .route("/admin/pigeon/conversations/{id}/read", web::post().to(h::mark_read))
        .route("/admin/pigeon/conversations/{id}/handled", web::post().to(h::mark_handled))
        .route("/admin/pigeon/conversations/{id}/draft", web::post().to(h::draft))
        .route("/admin/pigeon/conversations/{id}/summary", web::get().to(h::summary))
        .route("/admin/pigeon/conversations/{id}/switches", web::put().to(h::conversation_switches))
        .route("/admin/pigeon/general", web::get().to(h::general))
        .route("/admin/pigeon/cards/{kind}/{id}", web::post().to(h::press))
        .route("/admin/pigeon/contacts", web::get().to(h::list_contacts))
        .route("/admin/pigeon/contacts", web::put().to(h::set_contact))
        .route("/admin/pigeon/contacts/learn", web::post().to(h::learn_all))
        .route("/admin/pigeon/contacts/{id}", web::get().to(h::get_contact))
        .route("/admin/pigeon/contacts/{id}/note", web::put().to(h::set_contact_note))
        .route("/admin/pigeon/contacts/{id}/merge", web::post().to(h::merge_contacts))
        .route("/admin/pigeon/contacts/{id}/switches", web::put().to(h::contact_switches))
        .route("/admin/pigeon/contacts/{id}/learn", web::post().to(h::learn_contact))
        .route("/admin/pigeon/rules", web::get().to(h::list_rules))
        .route("/admin/pigeon/rules", web::put().to(h::set_rule))
        .route("/admin/pigeon/rules/{id}", web::delete().to(h::delete_rule))
        .route("/admin/pigeon/rules/{id}/try", web::post().to(h::try_rule))
        .route("/admin/pigeon/rules/{id}/runs", web::get().to(h::rule_runs))
        .route("/admin/pigeon/settings", web::get().to(h::get_settings))
        .route("/admin/pigeon/settings", web::put().to(h::set_settings))
        .route("/admin/pigeon/connections", web::get().to(h::list_connections))
        .route("/admin/pigeon/connections/{id}", web::delete().to(h::disconnect))
        .route("/admin/pigeon/connections/{connector}/link", web::post().to(h::connect_link))
        .route("/admin/pigeon/connections/{connector}/pairing", web::get().to(h::connect_pairing))
        .route("/admin/pigeon/console/receive", web::post().to(h::console_receive))
        // the providers' side (no sign-in: a one-time link's token, a signature)
        .route("/pigeon/connect/{token}", web::get().to(connect::start))
        .route("/pigeon/connect/{connector}/callback", web::get().to(connect::finish))
        .service(
            web::resource("/pigeon/webhooks/{connector}")
                // WhatsApp's history comes in batches of up to ~1 MB
                .app_data(web::PayloadConfig::new(WEBHOOK_BODY))
                .route(web::get().to(webhooks::verify))
                .route(web::post().to(webhooks::deliver)),
        );
}

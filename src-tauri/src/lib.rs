mod agent;
mod cloud;
mod docs;
mod gmail;
mod hardware;
mod outlook;
mod secrets;
mod tabshare;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tabshare::start();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            cloud::cloud_key_set,
            cloud::cloud_key_delete,
            cloud::cloud_key_present,
            cloud::cloud_ask,
            tabshare::tab_pairing_token,
            tabshare::tab_regenerate_token,
            tabshare::tab_latest,
            tabshare::tab_clear,
            agent::agent_workspace_info,
            agent::agent_workspace_init,
            agent::agent_list,
            agent::agent_read,
            agent::agent_write,
            agent::agent_search,
            agent::agent_open_folder,
            agent::agent_backup_target,
            agent::agent_backup,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            hardware::hardware_probe,
            docs::docs_folders,
            docs::docs_add_folder,
            docs::docs_remove_folder,
            docs::docs_scan,
            docs::docs_extract,
            docs::docs_index_load,
            docs::docs_index_save,
            gmail::gmail_connect,
            gmail::gmail_refresh,
            gmail::gmail_search,
            gmail::gmail_get_message,
            gmail::gmail_create_draft,
            outlook::outlook_connect,
            outlook::outlook_refresh,
            outlook::outlook_search,
            outlook::outlook_recent,
            outlook::outlook_get_message,
            outlook::outlook_create_draft,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MrVilsyAgent");
}

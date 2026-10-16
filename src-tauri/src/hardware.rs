use serde::Serialize;
use sysinfo::System;

#[derive(Serialize)]
pub struct HardwareInfo {
    pub total_ram_gb: f64,
    pub available_ram_gb: f64,
    pub cpu_name: String,
    pub cpu_threads: usize,
}

// Read-only probe of this machine's RAM and CPU. GPU use is read from Ollama itself.
#[tauri::command]
pub fn hardware_probe() -> HardwareInfo {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    let gb = |bytes: u64| ((bytes as f64) / 1_073_741_824.0 * 10.0).round() / 10.0;
    HardwareInfo {
        total_ram_gb: gb(sys.total_memory()),
        available_ram_gb: gb(sys.available_memory()),
        cpu_name: sys.cpus().first().map(|cpu| cpu.brand().trim().to_string()).unwrap_or_default(),
        cpu_threads: sys.cpus().len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reports_memory_and_cpu() {
        let info = hardware_probe();
        assert!(info.total_ram_gb > 0.5);
        assert!(info.cpu_threads >= 1);
    }
}

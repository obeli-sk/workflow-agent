use anyhow::Result;
use wit_bindgen_rust::Opts;

fn main() -> Result<()> {
    println!("cargo:rerun-if-changed=wit/");
    const SNAKE_CASE: &str = r#"#[serde(rename_all = "snake_case")]"#;
    let type_selectors = [
        "obelisk-agent:stub/stub/session-input",
        "obelisk-agent:stub/stub/tool-output",
        "obelisk-agent:stub/stub/session-event",
        "obelisk-agent:llm/chat/completion-result",
        "obelisk-agent:stub/stub/output-chunk",
    ];

    Opts {
        generate_all: true,
        additional_derive_attributes: vec![
            "PartialEq".to_string(),
            "serde::Serialize".to_string(),
            "serde::Deserialize".to_string(),
        ],
        additional_type_attributes: type_selectors
            .into_iter()
            .map(|selector| (selector.to_string(), SNAKE_CASE.to_string()))
            .collect(),
        ..Default::default()
    }
    .build()
    .generate_to_out_dir(None)?;
    Ok(())
}

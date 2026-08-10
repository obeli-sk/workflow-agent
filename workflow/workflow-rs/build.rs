use anyhow::Result;
use wit_bindgen_rust::Opts;

fn main() -> Result<()> {
    println!("cargo:rerun-if-changed=wit/");
    let path = Opts {
        generate_all: true,
        additional_derive_attributes: vec![
            "PartialEq".to_string(),
            "serde::Serialize".to_string(),
            "serde::Deserialize".to_string(),
        ],
        ..Default::default()
    }
    .build()
    .generate_to_out_dir(None)?;

    let contents = std::fs::read_to_string(&path)?;
    // The JSON-serialized variant enums need snake_case tags. These are the
    // authored WIT variants (see `wit = "wit"` in deployment.toml) the workflow
    // reads or writes as JSON.
    let enum_re = regex::Regex::new(
        r"(pub enum (?:SessionInput|ToolOutput|SessionEvent|CompletionResult))",
    )
    .unwrap();
    let contents = enum_re
        .replace_all(&contents, "#[serde(rename_all = \"snake_case\")]\n$1")
        .into_owned();
    std::fs::write(path, contents)?;
    Ok(())
}

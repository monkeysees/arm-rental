use rental_replay::production::Result;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::Path,
};

fn contract(request: &Value) -> Result<Value> {
    match request["op"].as_str() {
        Some("config") => Ok(rental_replay::production::config::Config::parse(
            &request["env"],
            Path::new(request["cwd"].as_str().unwrap_or("/")),
        )?
        .values),
        Some("telegram") => rental_replay::production::transport::contract(request),
        Some("bot") => rental_replay::production::bot::contract(request.clone()),
        Some("private") => rental_replay::production::private::contract(request.clone()),
        Some("channel") => rental_replay::production::channel::contract(request.clone()),
        Some("crawl") => rental_replay::production::crawl::contract(request),
        Some("health") => rental_replay::production::health::contract(request),
        _ => rental_replay::production::source::contract(request.clone()),
    }
}

fn run() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("contract") {
        for line in io::stdin().lock().lines() {
            let result = serde_json::from_str::<Value>(&line?)
                .map_err(Into::into)
                .and_then(|request| contract(&request));
            println!(
                "{}",
                result.unwrap_or_else(|error| json!({"error":error.to_string()}))
            );
        }
        return Ok(());
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("state:inspect") {
        let directory = match args.as_slice() {
            [_] => std::env::var("DATA_DIRECTORY").unwrap_or_else(|_| "/app/.data".into()),
            [_, option, directory] if option == "--data-directory" => directory.clone(),
            _ => return Err("invalid state inspection options".into()),
        };
        println!(
            "{}",
            rental_replay::production::inspection::inspect(Path::new(&directory))?
        );
        return Ok(());
    }
    if matches!(
        args.first().map(String::as_str),
        Some("--version" | "version")
    ) && args.len() == 1
    {
        println!("rental-app {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.is_empty() || args == ["--help"] {
        println!(
            "rental-app COMMAND [OPTIONS]\n\nCommands:\n  serve                         Run the singleton application\n  state:init                    Initialize an absent production database\n  state:validate                Validate and upgrade installed state\n  state:inspect                 Inspect installed schema without mutation\n  backup:create                 Create a production recovery snapshot\n  backup:validate --snapshot DIR Validate an immutable snapshot\n  backup:restore --snapshot DIR Restore a validated snapshot\n  maintenance:report            Report retained state growth\n  storage:check                 Report free disk space\n  source:smoke                  Validate both List.am categories without serving\n  browser:cleanup               Report or remove the retired browser profile\n  health-check [--ready --json]  Probe the running application\n  contract                      Run the independent development oracle protocol\n\nRuntime configuration uses the documented environment catalog. State commands\nalso accept --data-directory DIR and --channel ID. Local HTTP peer overrides\nfor serve/source:smoke require NODE_ENV=test."
        );
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("browser:cleanup") {
        if args.len() > 2 {
            return Err("invalid browser cleanup options".into());
        }
        let config = rental_replay::production::config::Config::from_environment()?;
        println!(
            "{}",
            rental_replay::production::browser_cleanup::run(
                &config,
                args.get(1).map(String::as_str).unwrap_or("--dry-run")
            )?
        );
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("source:smoke") {
        let origin = match args.len() {
            1 => None,
            3 if args[1] == "--source-origin" => Some(args[2].as_str()),
            _ => return Err("invalid source smoke options".into()),
        };
        let result = rental_replay::production::operations::source_smoke(
            &rental_replay::production::config::Config::from_environment()?,
            origin,
        )?;
        println!(
            "{}",
            json!({"event":"source.smoke.passed","pages":result["pages"]})
        );
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("health-check") {
        if !rental_replay::production::health_cli::run(&args[1..])? {
            std::process::exit(1);
        }
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("serve") {
        let mut options = std::collections::HashMap::new();
        let mut pairs = args[1..].chunks_exact(2);
        for pair in &mut pairs {
            if !["--telegram-endpoint", "--source-origin", "--cba-endpoint"]
                .contains(&pair[0].as_str())
                || options.insert(pair[0].clone(), pair[1].clone()).is_some()
            {
                return Err("unknown or repeated service option".into());
            }
        }
        if !pairs.remainder().is_empty() {
            return Err("missing service option value".into());
        }
        return rental_replay::production::runtime::serve(
            rental_replay::production::config::Config::from_environment()?,
            &options,
        );
    }
    if matches!(
        args.first().map(String::as_str),
        Some("maintenance:report" | "storage:check")
    ) && args.len() == 1
    {
        let config = rental_replay::production::config::Config::from_environment()?;
        let output = if args[0] == "maintenance:report" {
            let _lease = rental_replay::production::lease::Lease::acquire(Path::new(
                config.text("dataDirectory"),
            ))?;
            rental_replay::production::recovery::maintenance(
                &config,
                rental_replay::production::runtime::now_ms(),
            )?
        } else {
            rental_replay::production::recovery::disk_check(
                Path::new(config.text("dataDirectory")),
                config
                    .get("diskFreeWarningFraction")
                    .as_f64()
                    .unwrap_or(0.2),
            )?
        };
        println!("{output}");
        return Ok(());
    }
    if matches!(
        args.first().map(String::as_str),
        Some("backup:create" | "backup:validate" | "backup:restore")
    ) {
        use rental_replay::production::{config::Config, lease::Lease, recovery};
        let config = Config::from_environment()?;
        let result = match args[0].as_str() {
            "backup:create" if args.len() == 1 => {
                let _lease = Lease::acquire(Path::new(config.text("dataDirectory")))?;
                recovery::create_snapshot(
                    &config,
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)?
                        .as_millis() as i64,
                )?
            }
            "backup:validate" | "backup:restore" if args.len() == 3 && args[1] == "--snapshot" => {
                if args[0] == "backup:restore" {
                    let _lease = Lease::acquire(Path::new(config.text("dataDirectory")))?;
                    recovery::restore_snapshot(&config, Path::new(&args[2]))?
                } else {
                    recovery::validate_snapshot(&config, Path::new(&args[2]))?
                }
            }
            _ => return Err("invalid backup command options".into()),
        };
        println!("{result}");
        return Ok(());
    }
    if matches!(
        args.first().map(String::as_str),
        Some("state:init" | "state:validate")
    ) {
        let mut directory = None;
        let mut channel = None;
        let mut options = args[1..].chunks_exact(2);
        for pair in &mut options {
            match pair[0].as_str() {
                "--data-directory" if directory.is_none() => directory = Some(pair[1].as_str()),
                "--channel" if channel.is_none() => channel = Some(pair[1].as_str()),
                _ => return Err("unknown or repeated state option".into()),
            }
        }
        if !options.remainder().is_empty() {
            return Err("missing option value".into());
        }
        let environment = if directory.is_none() {
            Some(rental_replay::production::config::Config::from_environment()?)
        } else {
            None
        };
        let directory = directory
            .or_else(|| {
                environment
                    .as_ref()
                    .map(|config| config.text("dataDirectory"))
            })
            .ok_or("--data-directory required")?;
        let channel = channel.or_else(|| {
            environment
                .as_ref()
                .and_then(|config| config.get("telegramChannelId").as_str())
        });
        let path = Path::new(directory);
        let _lease = rental_replay::production::lease::Lease::acquire(path)?;
        let db = if args[0] == "state:init" {
            rental_replay::production::storage::Database::initialize(path, channel)?
        } else {
            rental_replay::production::storage::Database::open(path, channel)?
        };
        println!("{}", db.validate()?);
        return Ok(());
    }
    Err("unknown production command".into())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

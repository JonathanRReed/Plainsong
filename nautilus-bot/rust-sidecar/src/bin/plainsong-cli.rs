//! `plainsong`: the command-line tool and read-only MCP server.
//!
//! A separate binary from the sidecar: Electron spawns the sidecar over stdio
//! and there is no socket for a terminal or an assistant to reach, so this
//! process opens the same database itself, read-only, and answers from the
//! library's own query code. See `plainsong_lib::local_tools`.
//!
//! Exit codes: 0 ok, 1 error, 2 usage, 3 local tools are off, 4 not found.

use plainsong_lib::local_tools::{self, cli, mcp, ReadOnlyStore};
use std::io::{self, BufWriter, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match cli::parse_args(&args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("plainsong: {error}\n\n{}", cli::USAGE);
            return ExitCode::from(2);
        }
    };

    match command {
        cli::Command::Help => {
            print!("{}", cli::USAGE);
            return ExitCode::SUCCESS;
        }
        cli::Command::Version => {
            println!("plainsong {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        _ => {}
    }

    // The gate is checked before the database is touched, so a refused run
    // never reaches the keychain.
    let gate = local_tools::local_tools_gate();
    if !gate.is_enabled() {
        eprintln!("{}", gate.refusal_message());
        return ExitCode::from(local_tools::EXIT_LOCAL_TOOLS_DISABLED as u8);
    }

    let store = match ReadOnlyStore::open() {
        Ok(store) => store,
        Err(error) => {
            eprintln!("plainsong: {error:#}");
            return ExitCode::from(1);
        }
    };

    if command == cli::Command::Mcp {
        let stdin = io::stdin();
        let stdout = io::stdout();
        // Only protocol messages may reach stdout; everything else is stderr.
        return match mcp::serve(&store, stdin.lock(), BufWriter::new(stdout.lock())) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("plainsong mcp: {error}");
                ExitCode::from(1)
            }
        };
    }

    let stdout = io::stdout();
    let stderr = io::stderr();
    let mut out = BufWriter::new(stdout.lock());
    let mut err = stderr.lock();
    let code = match cli::run(&command, &store, &mut out, &mut err) {
        Ok(code) => code,
        Err(error) => {
            let _ = out.flush();
            eprintln!("plainsong: {error:#}");
            1
        }
    };
    if let Err(error) = out.flush() {
        // A closed pipe (`plainsong list | head`) is not an error worth noise.
        if error.kind() != io::ErrorKind::BrokenPipe {
            eprintln!("plainsong: {error}");
            return ExitCode::from(1);
        }
    }
    ExitCode::from(code.clamp(0, 255) as u8)
}

#[cfg(feature = "asr-parakeet")]
#[test]
fn print_moonshine_onnx_signatures() {
    use ort::session::Session;
    use std::path::PathBuf;

    let base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Nautilus")
        .join("models")
        .join("moonshine");

    let enc = if base.join("encoder_model.onnx").exists() {
        base.join("encoder_model.onnx")
    } else {
        base.join("encode.onnx")
    };
    let dec = if base.join("decoder_model_merged.onnx").exists() {
        base.join("decoder_model_merged.onnx")
    } else {
        base.join("uncached_decode.onnx")
    };

    if !enc.exists() || !dec.exists() {
        println!("moonshine onnx files not present");
        return;
    }

    let enc_sess = Session::builder().unwrap().commit_from_file(&enc).unwrap();
    println!("encoder inputs:");
    for i in enc_sess.inputs() {
        println!("- {} {:?}", i.name(), i);
    }
    println!("encoder outputs:");
    for o in enc_sess.outputs() {
        println!("- {} {:?}", o.name(), o);
    }

    let dec_sess = Session::builder().unwrap().commit_from_file(&dec).unwrap();
    println!("decoder inputs:");
    for i in dec_sess.inputs() {
        println!("- {} {:?}", i.name(), i);
    }
    println!("decoder outputs:");
    for o in dec_sess.outputs() {
        println!("- {} {:?}", o.name(), o);
    }
}

#[cfg(not(feature = "asr-parakeet"))]
#[test]
fn print_moonshine_onnx_signatures() {
    println!("asr-parakeet feature not enabled");
}

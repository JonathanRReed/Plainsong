use super::*;

#[test]
#[ignore = "subprocess fixture"]
fn crash_writer_child() {
    let Some(root) = std::env::var_os("PLAINSONG_TEST_CRASH_WRITER_DIR") else {
        return;
    };
    let root = PathBuf::from(root);
    let path = root.join("meeting.wav");
    let mut writer = prepare_mono_wav_writer(&path, 16_000).unwrap();
    write_wav_samples(&mut writer, vec![0.5; 1_600]).unwrap();
    writer.flush().unwrap();
    write_wav_samples(&mut writer, vec![0.5; 32_000]).unwrap();
    std::fs::write(root.join("ready"), b"ready").unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
fn killed_writer_keeps_checkpointed_audio_and_recovers_the_unstamped_tail() {
    let dir = crate::test_fs::TempDir::new("meeting-killed-writer");
    crate::test_fs::kill_test_child_at_checkpoint(
        "audio::meeting_durability_tests::crash_writer_child",
        "PLAINSONG_TEST_CRASH_WRITER_DIR",
        dir.path(),
    );

    let path = dir.path().join("meeting.wav");
    assert_eq!(hound::WavReader::open(&path).unwrap().duration(), 1_600);
    crate::recording_audio::repair_plaintext_wav_header(&path).unwrap();
    let recovered = hound::WavReader::open(&path).unwrap();
    assert!(recovered.duration() > 1_600);
    assert!(recovered.duration() <= 33_600);
    assert!(recovered
        .into_samples::<i16>()
        .all(|sample| sample.unwrap() == 16_383));
}

#[test]
fn silence_is_saved_as_audio_without_becoming_a_writer_failure() {
    let dir = crate::test_fs::TempDir::new("meeting-silent-writer");
    let path = dir.path().join("meeting.wav");
    let writer = prepare_mono_wav_writer(&path, 16_000).unwrap();
    let (sender, receiver) = bounded(2);
    sender.send(vec![0.0; 16_000]).unwrap();
    drop(sender);
    write_wav_file(writer, receiver, &path).unwrap();
    let saved = hound::WavReader::open(&path).unwrap();
    assert_eq!(saved.duration(), 16_000);
    assert!(saved
        .into_samples::<i16>()
        .all(|sample| sample.unwrap() == 0));
}

#[cfg(unix)] // Extending this fixture creates a sparse file on Unix.
#[test]
fn a_full_riff_file_refuses_more_audio_before_the_header_overflows() {
    let dir = crate::test_fs::TempDir::new("meeting-riff-ceiling");
    let path = dir.path().join("long-meeting.wav");
    let data_bytes = (u32::MAX - 36) / 2 * 2;
    let mut header = encode_wav(&[], 16_000, 1).unwrap();
    header[4..8].copy_from_slice(&(data_bytes + 36).to_le_bytes());
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    std::fs::write(&path, header).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(u64::from(data_bytes) + 44)
        .unwrap();
    let mut writer = hound::WavWriter::append(&path).unwrap();
    let result = write_wav_samples(&mut writer, vec![0.25]);
    if result.is_ok() {
        // Hound would overflow again in Drop while this assertion unwinds.
        std::mem::forget(writer);
        panic!("a full RIFF file accepted another sample");
    }
    writer
        .finalize()
        .expect("the existing audio must remain finalizable");
    assert_eq!(
        hound::WavReader::open(&path).unwrap().duration(),
        data_bytes / 2
    );
}

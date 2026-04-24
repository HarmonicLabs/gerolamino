use byteorder::{BigEndian, ReadBytesExt, WriteBytesExt};

use std::io::Cursor;
use wasm_bindgen::prelude::*;

// Typed error surface. Every fallible `#[wasm_bindgen]` export returns
// `Result<T, FramingError>` instead of `Result<T, JsValue>` so the TS side
// can decode via `Schema.TaggedErrorClass` on the `code` field.
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct FramingError {
    code: u16,
    message: String,
}

#[wasm_bindgen]
impl FramingError {
    #[wasm_bindgen(getter)]
    pub fn code(&self) -> u16 {
        self.code
    }

    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }
}

pub const ERR_SHORT_FRAME: u16 = 1;
pub const ERR_INCOMPLETE_PAYLOAD: u16 = 2;
pub const ERR_INVALID_PROTOCOL: u16 = 3;

impl FramingError {
    fn short_frame(got: usize) -> Self {
        FramingError {
            code: ERR_SHORT_FRAME,
            message: format!("frame shorter than 8-byte header: got {got}"),
        }
    }

    fn incomplete_payload(need: usize, got: usize) -> Self {
        FramingError {
            code: ERR_INCOMPLETE_PAYLOAD,
            message: format!("incomplete payload: need {need} bytes, got {got}"),
        }
    }

    fn invalid_protocol(id: u16) -> Self {
        FramingError {
            code: ERR_INVALID_PROTOCOL,
            message: format!("unknown mini-protocol id: {id}"),
        }
    }
}

// MiniProtocol IDs as per spec
#[derive(Clone, Copy, Debug)]
pub enum MiniProtocol {
    Handshake = 0,
    ChainSync = 2,
    BlockFetch = 3,
    TxSubmission = 4,
    LocalChainSync = 5,
    LocalTxSubmission = 6,
    LocalStateQuery = 7,
    KeepAlive = 8,
    LocalTxMonitor = 9,
    PeerSharing = 10,
}

impl MiniProtocol {
    pub fn from_u16(id: u16) -> Option<Self> {
        match id {
            0 => Some(MiniProtocol::Handshake),
            2 => Some(MiniProtocol::ChainSync),
            3 => Some(MiniProtocol::BlockFetch),
            4 => Some(MiniProtocol::TxSubmission),
            5 => Some(MiniProtocol::LocalChainSync),
            6 => Some(MiniProtocol::LocalTxSubmission),
            7 => Some(MiniProtocol::LocalStateQuery),
            8 => Some(MiniProtocol::KeepAlive),
            9 => Some(MiniProtocol::LocalTxMonitor),
            10 => Some(MiniProtocol::PeerSharing),
            _ => None,
        }
    }
}

// Multiplexer header
#[derive(Debug)]
pub struct MultiplexerHeader {
    pub transmission_time: u32,
    pub has_agency: bool,
    pub protocol: MiniProtocol,
    pub payload_length: u16,
}

// Wrap multiplexer message
#[wasm_bindgen]
pub fn wrap_multiplexer_message(payload: &[u8], protocol: u16, has_agency: bool) -> Vec<u8> {
    let mut buf = Vec::with_capacity(payload.len() + 8);

    // Transmission time (microseconds since epoch, approximated)
    let time = (js_sys::Date::now() * 1000.0) as u32;
    buf.write_u32::<BigEndian>(time)
        .expect("infallible: writing to Vec<u8>");

    // Agency and protocol
    let agency_and_protocol = if has_agency { 0 } else { 0x8000 } | (protocol & 0x7FFF);
    buf.write_u16::<BigEndian>(agency_and_protocol)
        .expect("infallible: writing to Vec<u8>");

    // Payload length
    buf.write_u16::<BigEndian>(payload.len() as u16)
        .expect("infallible: writing to Vec<u8>");

    // Payload
    buf.extend_from_slice(payload);

    buf
}

// Unwrap multiplexer message
#[wasm_bindgen]
pub fn unwrap_multiplexer_message(message: &[u8]) -> Result<JsValue, FramingError> {
    if message.len() < 8 {
        return Err(FramingError::short_frame(message.len()));
    }

    let mut cursor = Cursor::new(message);
    let transmission_time = cursor
        .read_u32::<BigEndian>()
        .expect("infallible: 4 bytes available after length guard");
    let agency_and_protocol = cursor
        .read_u16::<BigEndian>()
        .expect("infallible: 2 bytes available after length guard");
    let payload_length = cursor
        .read_u16::<BigEndian>()
        .expect("infallible: 2 bytes available after length guard");

    let has_agency = (agency_and_protocol & 0x8000) == 0;
    let protocol_id = agency_and_protocol & 0x7FFF;
    let protocol = MiniProtocol::from_u16(protocol_id)
        .ok_or_else(|| FramingError::invalid_protocol(protocol_id))?;

    let payload_start = 8;
    let required = payload_start + payload_length as usize;
    if message.len() < required {
        return Err(FramingError::incomplete_payload(required, message.len()));
    }

    let payload = &message[payload_start..required];

    let header = MultiplexerHeader {
        transmission_time,
        has_agency,
        protocol,
        payload_length,
    };

    let result = js_sys::Object::new();
    js_sys::Reflect::set(
        &result,
        &"transmissionTime".into(),
        &header.transmission_time.into(),
    )
    .expect("infallible: setting own property on fresh Object");
    js_sys::Reflect::set(&result, &"hasAgency".into(), &header.has_agency.into())
        .expect("infallible: setting own property on fresh Object");
    js_sys::Reflect::set(&result, &"protocol".into(), &protocol_id.into())
        .expect("infallible: setting own property on fresh Object");
    js_sys::Reflect::set(
        &result,
        &"payloadLength".into(),
        &header.payload_length.into(),
    )
    .expect("infallible: setting own property on fresh Object");
    js_sys::Reflect::set(
        &result,
        &"payload".into(),
        &js_sys::Uint8Array::from(payload),
    )
    .expect("infallible: setting own property on fresh Object");

    Ok(result.into())
}

// Buffer for accumulating chunks and processing frames
#[wasm_bindgen]
pub struct MultiplexerBuffer {
    buffer: Vec<u8>,
}

#[wasm_bindgen]
impl MultiplexerBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MultiplexerBuffer {
        MultiplexerBuffer { buffer: Vec::new() }
    }

    #[wasm_bindgen]
    pub fn append_chunk(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    #[wasm_bindgen]
    pub fn process_frames(&mut self) -> Vec<JsValue> {
        let mut frames = Vec::new();

        while self.buffer.len() >= 8 {
            let mut cursor = Cursor::new(&self.buffer[..8]);
            let _transmission_time = cursor
                .read_u32::<BigEndian>()
                .expect("infallible: 4 bytes available (buffer >= 8)");
            let _agency_and_protocol = cursor
                .read_u16::<BigEndian>()
                .expect("infallible: 2 bytes available (buffer >= 8)");
            let payload_length = cursor
                .read_u16::<BigEndian>()
                .expect("infallible: 2 bytes available (buffer >= 8)");

            let frame_len = 8 + payload_length as usize;
            if self.buffer.len() < frame_len {
                break;
            }

            let frame = &self.buffer[..frame_len];
            match unwrap_multiplexer_message(frame) {
                Ok(frame_data) => frames.push(frame_data),
                Err(err) => {
                    web_sys::console::error_1(
                        &format!(
                            "Invalid frame (code={}, msg={}), skipping: {:?}",
                            err.code, err.message, frame
                        )
                        .into(),
                    );
                }
            }

            self.buffer.drain(..frame_len);
        }

        frames
    }

    #[wasm_bindgen]
    pub fn buffer_len(&self) -> usize {
        self.buffer.len()
    }
}

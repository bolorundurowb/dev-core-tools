use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::command;
use image::ImageEncoder;

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageConvertOptions {
    pub input_path: String,
    pub output_dir: String,
    pub format: String,     // "PNG" | "JPG" | "WebP" | "AVIF" | "ICO"
    pub quality: u8,        // 0-100
    pub resize_width: Option<u32>,
    pub resize_height: Option<u32>,
    pub keep_aspect: bool,
    pub strip_metadata: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageConvertResult {
    pub output_path: String,
    pub input_size: u64,
    pub output_size: u64,
    pub width: u32,
    pub height: u32,
}

#[command]
pub async fn convert_image(options: ImageConvertOptions) -> Result<ImageConvertResult, String> {
    let input_path = PathBuf::from(&options.input_path);
    let input_size = std::fs::metadata(&input_path)
        .map_err(|e| e.to_string())?
        .len();

    let mut img = image::open(&input_path).map_err(|e| e.to_string())?;

    // Resize if requested
    if let (Some(w), Some(h)) = (options.resize_width, options.resize_height) {
        img = if options.keep_aspect {
            img.resize(w, h, image::imageops::FilterType::Lanczos3)
        } else {
            img.resize_exact(w, h, image::imageops::FilterType::Lanczos3)
        };
    }

    let stem = input_path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let ext = match options.format.as_str() {
        "JPG" | "JPEG" => "jpg",
        "WebP" => "webp",
        "AVIF" => "avif",
        "ICO" => "ico",
        _ => "png",
    };

    let output_path = PathBuf::from(&options.output_dir).join(format!("{}.{}", stem, ext));
    if let Some(parent) = output_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    match options.format.as_str() {
        "JPG" | "JPEG" => {
            let rgb = img.to_rgb8();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                std::fs::File::create(&output_path).map_err(|e| e.to_string())?,
                options.quality,
            );
            encoder.encode_image(&rgb).map_err(|e| e.to_string())?;
        }
        "ICO" => {
            // ICO dimensions are stored in a single byte (0 = 256), so the
            // image must fit within 256x256. Downscale larger images while
            // preserving the aspect ratio.
            if img.width() > 256 || img.height() > 256 {
                let scale = f64::min(256.0 / img.width() as f64, 256.0 / img.height() as f64);
                let w = (img.width() as f64 * scale).round().clamp(1.0, 256.0) as u32;
                let h = (img.height() as f64 * scale).round().clamp(1.0, 256.0) as u32;
                img = img.resize(w, h, image::imageops::FilterType::Lanczos3);
            }
            if img.width() > 256 || img.height() > 256 {
                img = img.resize_exact(img.width().min(256), img.height().min(256), image::imageops::FilterType::Lanczos3);
            }

            let mut png_buf = Vec::new();
            let rgb = img.to_rgba8();
            let png_encoder = image::codecs::png::PngEncoder::new(&mut png_buf);
            png_encoder.write_image(
                rgb.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgba8,
            ).map_err(|e| e.to_string())?;
            let frame = image::codecs::ico::IcoFrame::with_encoded(
                png_buf,
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgba8,
            ).map_err(|e| e.to_string())?;
            let encoder = image::codecs::ico::IcoEncoder::new(
                std::fs::File::create(&output_path).map_err(|e| e.to_string())?,
            );
            encoder.encode_images(&[frame]).map_err(|e| e.to_string())?;
        }
        "WebP" => {
            img.save(&output_path).map_err(|e| e.to_string())?;
        }
        _ => {
            img.save(&output_path).map_err(|e| e.to_string())?;
        }
    }

    let (width, height) = (img.width(), img.height());
    let output_size = std::fs::metadata(&output_path)
        .map_err(|e| e.to_string())?
        .len();

    Ok(ImageConvertResult {
        output_path: output_path.to_string_lossy().to_string(),
        input_size,
        output_size,
        width,
        height,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CropOptions {
    pub input_path: String,
    pub output_path: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub quality: u8,
}

#[command]
pub async fn crop_image(options: CropOptions) -> Result<ImageConvertResult, String> {
    let input_path = PathBuf::from(&options.input_path);
    let input_size = std::fs::metadata(&input_path)
        .map_err(|e| e.to_string())?
        .len();

    let img = image::open(&input_path).map_err(|e| e.to_string())?;
    let cropped = img.crop_imm(options.x, options.y, options.width, options.height);

    cropped.save(&options.output_path).map_err(|e| e.to_string())?;

    let output_size = std::fs::metadata(&options.output_path)
        .map_err(|e| e.to_string())?
        .len();

    Ok(ImageConvertResult {
        output_path: options.output_path,
        input_size,
        output_size,
        width: options.width,
        height: options.height,
    })
}

#[command]
pub async fn get_image_info(path: String) -> Result<serde_json::Value, String> {
    let img = image::open(&path).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    Ok(serde_json::json!({
        "width": img.width(),
        "height": img.height(),
        "color": format!("{:?}", img.color()),
        "size_bytes": size,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_convert_ico_512() {
        let temp_dir = std::env::temp_dir();
        let input_path = temp_dir.join("test_ico_512.png");
        let img = image::RgbaImage::new(512, 512);
        img.save(&input_path).unwrap();

        let res = convert_image(ImageConvertOptions {
            input_path: input_path.to_str().unwrap().to_string(),
            output_dir: temp_dir.to_str().unwrap().to_string(),
            format: "ICO".to_string(),
            quality: 90,
            resize_width: None,
            resize_height: None,
            keep_aspect: true,
            strip_metadata: true,
        }).await;

        println!("Result: {:?}", res);
        assert!(res.is_ok(), "Failed: {:?}", res.err());
    }

    #[tokio::test]
    async fn test_convert_ico_256() {
        let temp_dir = std::env::temp_dir();
        let input_path = temp_dir.join("test_ico_256.png");
        let img = image::RgbaImage::new(256, 256);
        img.save(&input_path).unwrap();

        let res = convert_image(ImageConvertOptions {
            input_path: input_path.to_str().unwrap().to_string(),
            output_dir: temp_dir.to_str().unwrap().to_string(),
            format: "ICO".to_string(),
            quality: 90,
            resize_width: None,
            resize_height: None,
            keep_aspect: true,
            strip_metadata: true,
        }).await;

        println!("Result: {:?}", res);
        assert!(res.is_ok(), "Failed: {:?}", res.err());
    }

    #[tokio::test]
    async fn test_convert_ico_rectangular() {
        let temp_dir = std::env::temp_dir();
        let input_path = temp_dir.join("test_ico_rect.png");
        let img = image::RgbaImage::new(400, 200);
        img.save(&input_path).unwrap();

        let res = convert_image(ImageConvertOptions {
            input_path: input_path.to_str().unwrap().to_string(),
            output_dir: temp_dir.to_str().unwrap().to_string(),
            format: "ICO".to_string(),
            quality: 90,
            resize_width: None,
            resize_height: None,
            keep_aspect: true,
            strip_metadata: true,
        }).await;

        println!("Result: {:?}", res);
        assert!(res.is_ok(), "Failed: {:?}", res.err());
    }

    #[tokio::test]
    async fn test_ico_structure() {
        let temp_dir = std::env::temp_dir();
        let ico_path = temp_dir.join("test_manual.ico");

        // Create a 16x16 PNG in memory
        let img = image::RgbaImage::new(16, 16);
        let mut png_bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        encoder.write_image(img.as_raw(), 16, 16, image::ExtendedColorType::Rgba8).unwrap();

        // Build ICO manually
        let mut ico_data = Vec::new();
        // Header
        ico_data.extend_from_slice(&0u16.to_le_bytes()); // reserved
        ico_data.extend_from_slice(&1u16.to_le_bytes()); // type 1
        ico_data.extend_from_slice(&1u16.to_le_bytes()); // count 1
        // Entry
        ico_data.push(16); // w
        ico_data.push(16); // h
        ico_data.push(0);  // colors
        ico_data.push(0);  // reserved
        ico_data.extend_from_slice(&1u16.to_le_bytes()); // planes
        ico_data.extend_from_slice(&32u16.to_le_bytes()); // bpp
        ico_data.extend_from_slice(&(png_bytes.len() as u32).to_le_bytes()); // size
        ico_data.extend_from_slice(&22u32.to_le_bytes()); // offset 22
        // Data
        ico_data.extend_from_slice(&png_bytes);

        std::fs::write(&ico_path, &ico_data).unwrap();

        // Now test if image crate can open and decode it!
        let opened = image::open(&ico_path);
        assert!(opened.is_ok(), "Failed to open manual ICO: {:?}", opened.err());
        let decoded = opened.unwrap();
        assert_eq!(decoded.width(), 16);
        assert_eq!(decoded.height(), 16);
    }
}

pub mod repo;
pub mod service;

use super::*;

pub fn describe() -> String {
    vendor::vendor_name().to_string()
}

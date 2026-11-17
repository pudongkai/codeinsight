mod cli;

use shop_core::order::repo::MemRepo;
use shop_core::order::service::Service;

#[derive(pm::Touch)]
struct Marker;

#[pm::mark]
fn main() {
    let _ = Marker;
    let port = std::env::var("APP_PORT").unwrap_or_default();
    let svc = Service::new(MemRepo::default());
    let _ = svc.create(1);
    cli::run(&port);
}

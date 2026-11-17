mod common;

use shop_core::order::repo::MemRepo;
use shop_core::Service;

#[test]
fn create_works() {
    common::setup();
    let svc = Service::new(MemRepo::default());
    assert!(svc.create(1).is_none());
}

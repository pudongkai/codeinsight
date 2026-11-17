/// Storage for orders.
pub trait Repo {
    /// Looks up an order by id.
    fn find(&self, id: u64) -> Option<String>;

    fn exists(&self, id: u64) -> bool {
        self.find(id).is_some()
    }
}

#[derive(Default)]
pub struct MemRepo {
    items: Vec<String>,
}

impl Repo for MemRepo {
    fn find(&self, id: u64) -> Option<String> {
        self.items.get(id as usize).cloned()
    }
}

pub struct Foo(pub u32);

impl From<u8> for Foo {
    fn from(v: u8) -> Self {
        Foo(v as u32)
    }
}

impl From< u16 > for Foo {
    fn from(v: u16) -> Self {
        Foo(v as u32)
    }
}

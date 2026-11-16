//! How one of tabtop's own WebAssembly modules is given bytes and replies
//! with bytes, by the worker that loads it (`ownModule` in
//! tabtopd/disasm-worker.js). It has no imports, and what it and the worker
//! share is its memory:
//!
//! - the worker asks `alloc(len)` for room, and writes what it gives there;
//! - it calls a function of the module's with where that is and how long,
//!   which takes the bytes with [`given`] (freeing them when it's done) and
//!   answers with [`reply`]: how long its reply is;
//! - the worker reads that many bytes from where `reply()` says, before it
//!   asks anything else (the next reply takes the last one's place).
//!
//! A module has `alloc` and `reply` for the worker by [`exports!`]; its own
//! functions are its own.

use std::cell::RefCell;

thread_local! {
    static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Room for `len` bytes, the worker's to write in until it's taken by [`given`].
pub fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// What the worker wrote: the bytes, the module's own from here.
///
/// # Safety
/// `pointer` is from `alloc(len)`, with `len` bytes written, and not yet taken.
pub unsafe fn given(pointer: *mut u8, len: usize) -> Vec<u8> {
    Vec::from_raw_parts(pointer, len, len.max(1))
}

/// Keeps `bytes` as the reply, for the worker to read from [`reply_at`]: how long it is.
pub fn reply(bytes: Vec<u8>) -> usize {
    let len = bytes.len();
    REPLY.with(|r| *r.borrow_mut() = bytes);
    len
}

/// Where the reply is.
pub fn reply_at() -> *const u8 {
    REPLY.with(|r| r.borrow().as_ptr())
}

/// `alloc` and `reply`, as the worker calls them, in the module that says this.
#[macro_export]
macro_rules! exports {
    () => {
        #[no_mangle]
        pub extern "C" fn alloc(len: usize) -> *mut u8 {
            $crate::alloc(len)
        }

        #[no_mangle]
        pub extern "C" fn reply() -> *const u8 {
            $crate::reply_at()
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn there_and_back() {
        let pointer = alloc(3);
        let bytes = unsafe {
            std::ptr::copy_nonoverlapping(b"abc".as_ptr(), pointer, 3);
            given(pointer, 3)
        };
        assert_eq!(bytes, b"abc");
        assert_eq!(reply(bytes.iter().rev().copied().collect()), 3);
        assert_eq!(unsafe { std::slice::from_raw_parts(reply_at(), 3) }, b"cba");
        // Nothing given, nothing in reply.
        assert_eq!(unsafe { given(alloc(0), 0) }, b"");
        assert_eq!(reply(Vec::new()), 0);
    }
}

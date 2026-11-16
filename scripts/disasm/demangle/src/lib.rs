//! The names of C++ and Rust symbols as they were written: what a compiler
//! made of `std::vector<int>::push_back(int const&)` to fit it in a
//! symbol (`_ZNSt6vectorIiSaIiEE9push_backERKi`), read back. For the hex
//! view's programs (see tabtopd/exe-info.js), in its worker
//! (disasm-worker.js). Rust's two schemes with rustc-demangle, C++'s as
//! GCC and Clang write it (the Itanium ABI's) with cpp_demangle, and as
//! Microsoft's compiler does with msvc-demangler.

use msvc_demangler::DemangleFlags;

/// `name` as it was written, or `None` if it isn't a mangled name (or not
/// one that can be read).
pub fn demangled(name: &str) -> Option<String> {
    // Microsoft's: ?push_back@?$vector@H@std@@QEAAXAEBH@Z. As the others
    // are shown: no return type, calling convention or "public:".
    if name.starts_with('?') {
        let flags = DemangleFlags::NO_ACCESS_SPECIFIERS
            | DemangleFlags::NO_FUNCTION_RETURNS
            | DemangleFlags::NO_MEMBER_TYPE
            | DemangleFlags::NO_MS_KEYWORDS
            | DemangleFlags::NO_THISTYPE
            | DemangleFlags::SPACE_AFTER_COMMA;
        return msvc_demangler::demangle(name, flags).ok().filter(|text| !text.is_empty() && text != name);
    }
    // (32-bit Windows and macOS put one more underscore before a name.)
    let name = if name.starts_with("__Z") || name.starts_with("__R") { &name[1..] } else { name };
    if !name.starts_with("_Z") && !name.starts_with("_R") {
        return None;
    }
    // Rust's, the older of which is written as a C++ name is: without the
    // hash that ends it (h0123456789abcdef), which says nothing.
    if let Ok(rust) = rustc_demangle::try_demangle(name) {
        return Some(format!("{rust:#}"));
    }
    // C++'s. What a compiler adds after a name when it makes another copy
    // of a function (.cold, .part.0, .constprop.1) isn't part of it: shown
    // after, as c++filt does.
    let (mangled, clone) = match name.find('.') {
        Some(at) => (&name[..at], &name[at..]),
        None => (name, ""),
    };
    let text = cpp_demangle::Symbol::new(mangled).ok()?.demangle().ok()?;
    Some(if clone.is_empty() { text } else { format!("{text} [clone {clone}]") })
}

// What the worker calls: names, a line each, written where alloc() says,
// then demangle(), whose reply (at reply()) is a line for each: the name as
// it was written, or an empty line for one that isn't mangled.
wasm_reply::exports!();

/// # Safety
/// `pointer` is from `alloc(len)`, with `len` bytes written; it's freed here.
#[no_mangle]
pub unsafe extern "C" fn demangle(pointer: *mut u8, len: usize) -> usize {
    let bytes = wasm_reply::given(pointer, len);
    let names = String::from_utf8_lossy(&bytes);
    let mut reply = Vec::new();
    for (n, name) in names.split('\n').enumerate() {
        if n > 0 {
            reply.push(b'\n');
        }
        // (A name written over more than one line would put the rest out of step.)
        if let Some(text) = demangled(name).filter(|text| !text.contains('\n')) {
            reply.extend_from_slice(text.as_bytes());
        }
    }
    wasm_reply::reply(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_as_written() {
        for (name, want) in [
            // C++, as GCC and Clang write it.
            ("_Z3foov", "foo()"),
            ("_ZN3Foo3barEi", "Foo::bar(int)"),
            ("_ZNSt6vectorIiSaIiEE9push_backERKi", "std::vector<int, std::allocator<int> >::push_back(int const&)"),
            ("_ZNK3Foo5valueEv", "Foo::value() const"),
            ("_ZN3FooC1Ev", "Foo::Foo()"),
            ("_ZTV3Foo", "vtable for Foo"),
            ("_Z3foov.cold", "foo() [clone .cold]"),
            ("_ZN3Foo3barEi.part.0", "Foo::bar(int) [clone .part.0]"),
            ("__ZN3Foo3barEi", "Foo::bar(int)"),
            // Rust, the older way and the newer; without their hashes.
            ("_ZN4core3fmt5write17h0123456789abcdefE", "core::fmt::write"),
            ("_ZN3std2rt10lang_start17h0123456789abcdefE.llvm.123", "std::rt::lang_start"),
            ("_RNvCs1234_7mycrate3foo", "mycrate::foo"),
            ("_RNvNtCs1234_7mycrate3bar3baz", "mycrate::bar::baz"),
            // C++, as Microsoft's compiler writes it.
            ("?foo@@YAHH@Z", "foo(int)"),
            ("?bar@Foo@@QEAAHH@Z", "Foo::bar(int)"),
        ] {
            assert_eq!(demangled(name).as_deref(), Some(want), "{name}");
        }
    }

    #[test]
    fn names_that_arent_mangled() {
        for name in ["", "main", "_start", "puts", "_Z", "_ZZZ", "_R", "?", "??", "_Znot a name", "__imp_Sleep", "KERNEL32!Sleep", "printf@plt"] {
            assert_eq!(demangled(name), None, "{name}");
        }
    }

    #[test]
    fn names_a_line_each() {
        let names = b"main\n_Z3foov\n\n_ZN4core3fmt5write17h0123456789abcdefE\n_Zbad";
        let pointer = alloc(names.len());
        unsafe {
            std::ptr::copy_nonoverlapping(names.as_ptr(), pointer, names.len());
            let len = demangle(pointer, names.len());
            assert_eq!(std::slice::from_raw_parts(reply(), len), b"\nfoo()\n\ncore::fmt::write\n");
        }
    }
}

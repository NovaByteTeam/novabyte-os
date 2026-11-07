################################################################################
#
# m4 (host only)
#
################################################################################

M4_VERSION = 1.4.19
M4_SOURCE = m4-$(M4_VERSION).tar.xz
M4_SITE = $(BR2_GNU_MIRROR)/m4
M4_LICENSE = GPL-3.0+
M4_LICENSE_FILES = COPYING

# GCC 13 (ubuntu-latest) expands _GL_ATTRIBUTE_NODISCARD to [[nodiscard]]
# and rejects it between an inline specifier and the return type in C11/C17
# mode, breaking the gnulib build inside m4's lib/ directory:
#
#   gl_oset.h:275:40: error: expected identifier or '(' before 'int'
#     GL_OSET_INLINE _GL_ATTRIBUTE_NODISCARD int
#
# Passing the autoconf cache variable disables the [[nodiscard]] probe so
# gnulib falls back to __attribute__((warn_unused_result)) instead, which
# GCC accepts in any position.
HOST_M4_CONF_ENV += gl_cv_attribute_nodiscard=no

$(eval $(host-autotools-package))

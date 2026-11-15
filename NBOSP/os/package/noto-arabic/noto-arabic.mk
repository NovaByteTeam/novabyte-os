NOTO_ARABIC_VERSION = ffebf8c1ee449e544955a7e813c54f9b73848eac
NOTO_ARABIC_SITE = https://raw.githubusercontent.com/googlefonts/noto-fonts/$(NOTO_ARABIC_VERSION)/hinted/ttf/NotoSansArabic
NOTO_ARABIC_SOURCE = NotoSansArabic-Regular.ttf
NOTO_ARABIC_EXTRA_DOWNLOADS = \
	$(NOTO_ARABIC_SITE)/NotoSansArabic-Bold.ttf \
	https://raw.githubusercontent.com/googlefonts/noto-fonts/$(NOTO_ARABIC_VERSION)/LICENSE
NOTO_ARABIC_LICENSE = OFL-1.1
NOTO_ARABIC_LICENSE_FILES = LICENSE

define NOTO_ARABIC_EXTRACT_CMDS
	mkdir -p $(@D)
	cp $(NOTO_ARABIC_DL_DIR)/NotoSansArabic-Regular.ttf $(@D)/NotoSansArabic-Regular.ttf
	cp $(NOTO_ARABIC_DL_DIR)/NotoSansArabic-Bold.ttf $(@D)/NotoSansArabic-Bold.ttf
	cp $(NOTO_ARABIC_DL_DIR)/LICENSE $(@D)/LICENSE
endef

define NOTO_ARABIC_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0644 $(@D)/NotoSansArabic-Regular.ttf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf
	$(INSTALL) -D -m 0644 $(@D)/NotoSansArabic-Bold.ttf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf
	$(INSTALL) -D -m 0644 $(@D)/LICENSE \
		$(TARGET_DIR)/usr/share/licenses/noto-arabic/OFL.txt
endef

$(eval $(generic-package))
